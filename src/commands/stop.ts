import path from "node:path";

import { loadProjectConfigAsync } from "../config/load.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { StudioStop } from "../studio/close-studio.ts";
import { closeStudio, STUDIO_CLOSE_MS } from "../studio/close-studio.ts";
import type { CommandContext, CommandInput } from "./context.ts";

/**
 * `forge stop`: close the Roblox Studio that has this project's place open.
 * Studio gets a close request; when it is still open after
 * {@link STUDIO_CLOSE_MS}, forge ends it without a save (`closeStudio`). It
 * acts only on the Studio its identity check verifies.
 *
 * @param context - The run: project directory, config loader, file system,
 *   and native addon.
 * @param input - The config values flags set.
 * @returns Whether a Studio was stopped, its PID, the place, and whether
 *   forge had to end it.
 * @rejects `identity_mismatch` when the lock file names no process or
 *   another computer, or a process that is not Studio, started after the
 *   lock file was written, or cannot be checked; `process_failed` when
 *   Studio does not exit in time; config errors from
 *   `loadProjectConfigAsync`.
 */
export async function runStopAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const { config } = await loadProjectConfigAsync(
		context.cwd,
		context.seams.configLoader,
		input.config,
	);
	const place = path.resolve(context.cwd, config.open.buildOutputPath ?? config.buildOutputPath);
	return stopResult(closeStudio(context.seams, place), place);
}

/**
 * The result of `forge stop` once Studio is gone.
 *
 * @param stop - How Studio went: its PID, and whether forge ended it.
 * @param place - The absolute path of the place file.
 * @returns Its data and summary.
 */
function stoppedResult(
	{ forced: isForced, pid }: Extract<StudioStop, { status: "stopped" }>,
	place: string,
): CommandResult {
	const how = isForced
		? `: it did not close within ${STUDIO_CLOSE_MS / 1000} s, so forge ended it without saving`
		: "";
	return {
		data: { forced: isForced, pid, place, stopped: true },
		summary: `Stopped Roblox Studio (PID ${pid}) for ${place}${how}.`,
	};
}

/**
 * The result of `forge stop`.
 *
 * @param stop - What closing Studio did.
 * @param place - The absolute path of the place file.
 * @returns Its data and summary.
 */
function stopResult(stop: StudioStop, place: string): CommandResult {
	switch (stop.status) {
		case "closed_first": {
			return {
				data: { pid: stop.pid, place, stopped: false },
				summary: `Roblox Studio (PID ${stop.pid}) closed ${place} while forge checked it.`,
			};
		}
		case "exited": {
			return {
				data: { pid: stop.pid, place, stopped: false },
				summary: `Roblox Studio is not running: the lock file names PID ${stop.pid}, which has exited.`,
			};
		}
		case "not_open": {
			return {
				data: { place, stopped: false },
				summary: `Roblox Studio does not have ${place} open.`,
			};
		}
		case "stopped": {
			return stoppedResult(stop, place);
		}
	}
}
