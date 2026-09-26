import path from "node:path";

import type { CommandContext } from "../commands/context.ts";
import { logFilePath, openLogFile } from "../output/log-file.ts";
import { createReaperRunner } from "./reaper-runner.ts";
import type { SessionScope } from "./run-session.ts";
import type { WatchOptions } from "./watch.ts";

/** How often the session looks at the place and Studio's lock file. */
export const FILE_POLL_MS = 500;

/** What a session's workers run with. */
export interface WorkerSetup {
	context: CommandContext;
	/** `.forge/sessions/<id>`: raw worker output while the session runs. */
	directory: string;
}

/**
 * The command context with a process runner that runs through the session's
 * reaper, so every step and hook is a worker.
 *
 * @param setup - The context and the session directory.
 * @param scope - Its reaper and end signal.
 * @param name - The log and worker-id prefix, such as `start`.
 * @returns The context for the steps.
 */
export function workerContext(
	{ context, directory }: WorkerSetup,
	scope: Pick<SessionScope, "reaper" | "signal">,
	name: string,
): CommandContext {
	const { clock, fileSystem } = context.seams;
	const processRunner = createReaperRunner({
		name,
		clock,
		fileSystem,
		log: openLogFile(fileSystem, logFilePath(context.cwd, name)),
		reaper: scope.reaper,
		signal: scope.signal,
		spoolDirectory: path.join(directory, "output"),
	});
	return { ...context, seams: { ...context.seams, processRunner } };
}

/**
 * How the session polls a file until it ends.
 *
 * @param context - The clock and file system.
 * @param scope - Its end signal.
 * @returns What a file watch polls with.
 */
export function watchOptions(
	context: CommandContext,
	scope: Pick<SessionScope, "signal">,
): WatchOptions {
	const { clock, fileSystem } = context.seams;
	return { clock, fileSystem, intervalMs: FILE_POLL_MS, signal: scope.signal };
}
