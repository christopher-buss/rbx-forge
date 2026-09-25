import { randomUUID } from "node:crypto";
import nodeFs from "node:fs";
import { createRequire } from "node:module";
import nodeNet from "node:net";
import process from "node:process";

import type { IpcTransport } from "../ipc/transport.ts";
import { createNodeTransport } from "../ipc/transport.ts";
import type { NativeLoader } from "../native/addon.ts";
import {
	createNativeLoader,
	createReaperLocator,
	isExecutableFile,
	readHost,
} from "../native/load.ts";
import { createChildProcessRunner } from "../process/process-runner.ts";
import type { ReaperLauncher } from "../reaper/reaper-client.ts";
import { createReaperLauncher } from "../reaper/reaper-client.ts";
import { createStudioLauncher } from "../studio/launcher.ts";
import { createDetachedLauncher } from "../supervisor/detached-launcher.ts";
import { createSupervisorLauncher } from "../supervisor/launcher.ts";
import { nodeChildProcessRunner } from "./child-process.ts";
import { nodeClock } from "./clock.ts";
import { loadConfigFileAsync } from "./config-loader.ts";
import { nodeFileSystem } from "./file-system.ts";
import { nodeHost } from "./host.ts";
import { nodeNetwork } from "./network.ts";
import { createReadlinePrompter } from "./prompter.ts";
import type { Seams } from "./seams.ts";
import { createSignals } from "./signals.ts";

/** What the real seams are built from. */
export interface NodeSeamsOptions {
	/** Prompt input: the process stdin. */
	input: NodeJS.ReadableStream;
	/**
	 * Load the native addon and the reaper from this directory instead of
	 * the platform package (`RBX_FORGE_NATIVE_DIR`).
	 */
	nativeDirectory: string | undefined;
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
 * @param options - Prompt streams, the native addon directory, and the
 *   supervisor entry.
 * @returns Seams backed by Node, c12, the native addon, and the terminal.
 */
export function createNodeSeams({
	input,
	nativeDirectory,
	output,
	supervisorEntry,
}: NodeSeamsOptions): Seams {
	const requireModule = createRequire(import.meta.url);
	const native = createNativeLoader({
		directory: nativeDirectory,
		readHost: () => readHost(process),
		requireModule,
	});
	return {
		childProcess: nodeChildProcessRunner,
		clock: nodeClock,
		configLoader: loadConfigFileAsync,
		detachedSupervisor: createDetachedLauncher(
			{ ...PROCESS_BACKEND, fileSystem: nodeFileSystem, native },
			supervisorEntry,
		),
		fileSystem: nodeFileSystem,
		host: nodeHost,
		ipc: createNodeIpcTransport(native),
		native,
		network: nodeNetwork,
		processRunner: createChildProcessRunner(PROCESS_BACKEND),
		prompter: createReadlinePrompter(input, output),
		randomId: randomUUID,
		reaper: createNodeReaperLauncher(nativeDirectory, native, requireModule),
		signals: createSignals(process),
		studioLauncher: createStudioLauncher(PROCESS_BACKEND),
		supervisor: createSupervisorLauncher(PROCESS_BACKEND, supervisorEntry),
	};
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
