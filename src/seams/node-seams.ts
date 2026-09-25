import { createChildProcessRunner } from "../process/process-runner.ts";
import { createStudioLauncher } from "../studio/launcher.ts";
import { nodeChildProcessRunner } from "./child-process.ts";
import { nodeClock } from "./clock.ts";
import { loadConfigFileAsync } from "./config-loader.ts";
import { nodeFileSystem } from "./file-system.ts";
import { nodeHost } from "./host.ts";
import { createReadlinePrompter } from "./prompter.ts";
import type { Seams } from "./seams.ts";

/** The terminal streams the real prompter uses. */
export interface TerminalStreams {
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
}

/**
 * The real seams. Only the CLI entry calls this.
 *
 * @param terminal - Streams for prompts (the process stdin and stdout).
 * @returns Seams backed by Node, c12, and the terminal.
 */
export function createNodeSeams({ input, output }: TerminalStreams): Seams {
	return {
		childProcess: nodeChildProcessRunner,
		clock: nodeClock,
		configLoader: loadConfigFileAsync,
		fileSystem: nodeFileSystem,
		host: nodeHost,
		processRunner: createChildProcessRunner({
			childProcess: nodeChildProcessRunner,
			clock: nodeClock,
			host: nodeHost,
		}),
		prompter: createReadlinePrompter(input, output),
		studioLauncher: createStudioLauncher({
			childProcess: nodeChildProcessRunner,
			clock: nodeClock,
			host: nodeHost,
		}),
	};
}
