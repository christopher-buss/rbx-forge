import { randomUUID } from "node:crypto";
import nodeFs from "node:fs";
import { createRequire } from "node:module";
import nodeNet from "node:net";
import process from "node:process";

import type { IpcTransport } from "../ipc/transport.ts";
import { createNodeTransport } from "../ipc/transport.ts";
import type { NativeLoader } from "../native/addon.ts";
import { createHelperClient } from "../native/helper-client.ts";
import {
	createNativeLoader,
	createReaperLocator,
	createWindowsHelperLocator,
	isExecutableFile,
	readHost,
} from "../native/load.ts";
import { readVariable } from "../process/environment.ts";
import { createChildProcessRunner } from "../process/process-runner.ts";
import { isWsl } from "../process/wsl.ts";
import type { ReaperLauncher } from "../reaper/reaper-client.ts";
import { createReaperLauncher } from "../reaper/reaper-client.ts";
import { createKeepHiddenLauncher, KEEP_HIDDEN_FLAG } from "../studio/keep-hidden.ts";
import type { StudioLauncher } from "../studio/launcher.ts";
import { createDetachedLauncher } from "../supervisor/detached-launcher.ts";
import { createSupervisorLauncher } from "../supervisor/launcher.ts";
import type { InstalledStudio } from "./addon-studio/discover.ts";
import { findInstalledStudio, noInstalledStudio as none } from "./addon-studio/discover.ts";
import { createStudioLauncher } from "./addon-studio/launcher.ts";
import { nodeChildProcessRunner } from "./child-process.ts";
import { nodeClock } from "./clock.ts";
import { loadConfigFileAsync } from "./config-loader.ts";
import { nodeFileSystem } from "./file-system.ts";
import { nodeHost } from "./host.ts";
import { nodeNetwork } from "./network.ts";
import { createReadlinePrompter } from "./prompter.ts";
import type { Seams } from "./seams.ts";
import { createSignals } from "./signals.ts";
import { createAddonStudioHost } from "./studio-host.ts";
import { createWslStudioHost } from "./wsl-studio-host.ts";

/** What the real seams are built from. */
export interface NodeSeamsOptions {
	/** The bundled `forge-plugin/ForgePlugin.rbxm` next to the CLI. */
	forgePluginPath: string;
	/** Prompt input: the process stdin. */
	input: NodeJS.ReadableStream;
	/**
	 * Load the native addon and the reaper from this directory instead of
	 * the platform package (`RBX_FORGE_NATIVE_DIR`).
	 */
	nativeDirectory: string | undefined;
	/**
	 * Find no installed Studio (`RBX_FORGE_TEST_NO_INSTALLED_STUDIO=1`), so
	 * e2e runs never start the real one.
	 */
	noInstalledStudio: boolean;
	/** Prompt output: the process stdout. */
	output: NodeJS.WritableStream;
	/** The supervisor entry script: `supervisor.mjs` next to the CLI. */
	supervisorEntry: string;
}

/** What every process-starting seam is built from. */
const PROCESS_BACKEND = { childProcess: nodeChildProcessRunner, clock: nodeClock, host: nodeHost };

/**
 * The real seams. Only the CLI entry calls this.
 *
 * @param options - Prompt streams, the native addon directory, the
 *   supervisor entry, and the bundled forge plugin.
 * @returns Seams backed by Node, c12, the native addon, and the terminal.
 */
export function createNodeSeams({
	forgePluginPath,
	input,
	nativeDirectory,
	noInstalledStudio,
	output,
	supervisorEntry,
}: NodeSeamsOptions): Seams {
	const requireModule = createRequire(import.meta.url);
	const native = createNodeNative(nativeDirectory, requireModule);
	return {
		childProcess: nodeChildProcessRunner,
		clock: nodeClock,
		configLoader: loadConfigFileAsync,
		detachedSupervisor: nodeDetachedLauncher(native, supervisorEntry),
		fileSystem: nodeFileSystem,
		host: nodeHost,
		ipc: createNodeIpcTransport(native),
		native,
		network: nodeNetwork,
		processRunner: createChildProcessRunner(PROCESS_BACKEND),
		prompter: createReadlinePrompter(input, output),
		randomId: randomUUID,
		readForgePlugin: () => nodeFs.readFileSync(forgePluginPath),
		reaper: createNodeReaperLauncher(nativeDirectory, native, requireModule),
		signals: createSignals(process),
		studioHost: createSelectedStudioHost({
			directory: nativeDirectory,
			entry: supervisorEntry,
			native,
			requireModule,
			skip: noInstalledStudio,
		}),
		supervisor: createSupervisorLauncher(PROCESS_BACKEND, supervisorEntry),
	};
}

function createNodeNative(
	directory: string | undefined,
	requireModule: NodeJS.Require,
): NativeLoader {
	return createNativeLoader({ directory, readHost: () => readHost(process), requireModule });
}

function createNodeIpcTransport(native: NativeLoader): IpcTransport {
	return createNodeTransport({
		fileSystem: nodeFs,
		native,
		net: nodeNet,
		platform: nodeHost.platform,
		userId: nodeHost.userId,
	});
}

function createNodeReaperLauncher(
	directory: string | undefined,
	native: NativeLoader,
	requireModule: NodeJS.Require,
): ReaperLauncher {
	return createReaperLauncher(
		{ childProcess: nodeChildProcessRunner, clock: nodeClock, host: nodeHost, native },
		createReaperLocator({
			directory,
			isExecutable: isExecutableFile,
			readHost: () => readHost(process),
			resolveModule: (id) => requireModule.resolve(id),
		}),
	);
}

function installedStudioLookup(skip: boolean): InstalledStudio {
	return skip ? none : findInstalledStudio;
}

function createNodeStudioLauncher(
	native: NativeLoader,
	noInstalledStudio: boolean,
	entry: string,
): StudioLauncher {
	return createStudioLauncher(
		{
			...PROCESS_BACKEND,
			fileSystem: nodeFileSystem,
			installedStudio: installedStudioLookup(noInstalledStudio),
			native,
		},
		entry,
	);
}

function createNodeStudioHost(
	native: NativeLoader,
	noInstalledStudio: boolean,
	entry: string,
): Seams["studioHost"] {
	return createAddonStudioHost({
		fileSystem: nodeFileSystem,
		host: nodeHost,
		installedStudio: installedStudioLookup(noInstalledStudio),
		native,
		studioLauncher: createNodeStudioLauncher(native, noInstalledStudio, entry),
	});
}

function helperLocator(directory: string | undefined, requireModule: NodeJS.Require): () => string {
	return createWindowsHelperLocator({
		directory,
		isExecutable: isExecutableFile,
		readHost: () => readHost(process),
		resolveModule: (id) => requireModule.resolve(id),
	});
}

// eslint-disable-next-line flawless/max-lines-per-function -- Select the process-local Studio backend and its detached watcher.
function createSelectedStudioHost({
	directory,
	entry,
	native,
	requireModule,
	skip,
}: {
	directory: string | undefined;
	entry: string;
	native: NativeLoader;
	requireModule: NodeJS.Require;
	skip: boolean;
}): Seams["studioHost"] {
	if (!isWsl(nodeHost.platform, process.env)) {
		return createNodeStudioHost(native, skip, entry);
	}

	const locate = helperLocator(directory, requireModule);
	return createWslStudioHost(
		{
			clock: nodeClock,
			cwd: process.cwd(),
			environment: process.env,
			...(process.argv[2] === KEEP_HIDDEN_FLAG
				? {}
				: { keepHidden: createKeepHiddenLauncher(PROCESS_BACKEND, entry) }),
			fileSystem: nodeFileSystem,
			processRunner: createChildProcessRunner(PROCESS_BACKEND),
		},
		() => {
			return createHelperClient(
				PROCESS_BACKEND,
				() => {
					const fake = readVariable(
						process.env,
						"RBX_FORGE_TEST_WINDOWS_HELPER",
						nodeHost.platform,
					);
					return fake === undefined
						? { args: [], file: locate() }
						: { args: [fake], file: nodeHost.execPath };
				},
				process.arch,
			);
		},
	);
}

function nodeDetachedLauncher(native: NativeLoader, entry: string): Seams["detachedSupervisor"] {
	return createDetachedLauncher(
		{ ...PROCESS_BACKEND, fileSystem: nodeFileSystem, native },
		entry,
	);
}
