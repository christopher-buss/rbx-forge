import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";

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
}

/**
 * The real seams. Only the CLI entry calls this.
 *
 * @param options - Prompt streams and the native addon directory.
 * @returns Seams backed by Node, c12, the native addon, and the terminal.
 */
export function createNodeSeams({ input, nativeDirectory, output }: NodeSeamsOptions): Seams {
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
		fileSystem: nodeFileSystem,
		host: nodeHost,
		native,
		network: nodeNetwork,
		processRunner: createChildProcessRunner({
			childProcess: nodeChildProcessRunner,
			clock: nodeClock,
			host: nodeHost,
		}),
		prompter: createReadlinePrompter(input, output),
		randomId: randomUUID,
		reaper: createNodeReaperLauncher(nativeDirectory, native, requireModule),
		signals: createSignals(process),
	};
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
