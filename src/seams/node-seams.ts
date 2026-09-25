import { createRequire } from "node:module";
import process from "node:process";

import { createNativeLoader, readHost } from "../native/load.ts";
import { createChildProcessRunner } from "../process/process-runner.ts";
import { nodeChildProcessRunner } from "./child-process.ts";
import { nodeClock } from "./clock.ts";
import { loadConfigFileAsync } from "./config-loader.ts";
import { nodeFileSystem } from "./file-system.ts";
import { nodeHost } from "./host.ts";
import { createReadlinePrompter } from "./prompter.ts";
import type { Seams } from "./seams.ts";

/** What the real seams are built from. */
export interface NodeSeamsOptions {
	/** Prompt input: the process stdin. */
	input: NodeJS.ReadableStream;
	/**
	 * Load the native addon from this directory instead of the platform
	 * package (`RBX_FORGE_NATIVE_DIR`).
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
	return {
		childProcess: nodeChildProcessRunner,
		clock: nodeClock,
		configLoader: loadConfigFileAsync,
		fileSystem: nodeFileSystem,
		host: nodeHost,
		native: createNativeLoader({
			directory: nativeDirectory,
			readHost: () => readHost(process),
			requireModule: createRequire(import.meta.url),
		}),
		processRunner: createChildProcessRunner({
			childProcess: nodeChildProcessRunner,
			clock: nodeClock,
			host: nodeHost,
		}),
		prompter: createReadlinePrompter(input, output),
	};
}
