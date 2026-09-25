import path from "node:path";

import type { FlagDefinition } from "../cli/flags.ts";
import { findSession } from "../client/session.ts";
import {
	RECOVERY_FLAG,
	recoveryOptions,
	sessionStudioTarget,
	waitForSessionStudioAsync,
} from "../client/studio.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { StudioEnd, StudioStop, StudioTarget } from "../studio/close-studio.ts";
import { closeStudioAsync, STUDIO_CLOSE_MS } from "../studio/close-studio.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const STOP_FLAGS: ReadonlyArray<FlagDefinition> = [RECOVERY_FLAG];

/** How the summary tells how Studio went. */
const HOW: Readonly<Record<StudioEnd, string>> = {
	dialog: ": a dialog blocked it, so forge ended it without saving",
	exited: "",
	lock_released: "",
	no_window: ": it had no window to close, so forge ended it without saving",
	timeout: `: it did not close within ${STUDIO_CLOSE_MS / 1000} s, so forge ended it without saving`,
};

/**
 * `forge stop`: close the Roblox Studio that has this project's place open.
 * When a session runs, it is the session's Studio (waiting while it is
 * still opening); else the Studio the place's lock file names. Studio gets
 * a close request; forge ends it once it closed the place, at once when a
 * dialog blocks it, and else after {@link STUDIO_CLOSE_MS}, without a save
 * (`closeStudioAsync`). It acts only on a Studio its identity check
 * verifies. The auto-recovery files of a Studio it forced are moved,
 * deleted, or kept (`studio.autoRecovery`, `--recovery`).
 *
 * @param context - The run: project directory, config loader, file system,
 *   clock, transport, and native addon.
 * @param input - The config values flags set.
 * @returns Whether a Studio was stopped, its PID, the place, how it went,
 *   and what forge did with its auto-recovery files.
 * @rejects `identity_mismatch` when the lock file names no process or
 *   another computer, or a process that is not Studio, started after the
 *   lock file was written, is not the session's Studio, or cannot be
 *   checked; `process_failed` when Studio does not exit in time; config
 *   errors from `loadProjectConfigAsync`.
 */
export async function runStopAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const { cwd, env, seams } = context;
	const { config } = await loadProjectConfigAsync(cwd, seams.configLoader, input.config);
	const forge = forgeFiles(cwd);
	const target = (await sessionTargetAsync(context)) ?? {
		place: path.resolve(cwd, config.open.buildOutputPath ?? config.buildOutputPath),
	};
	const stop = await closeStudioAsync(seams, target, recoveryOptions(env, forge, config));
	return stopResult(stop, target.place);
}

/**
 * The Studio of the project's running session.
 *
 * @param context - The file system, clock, and transport.
 * @returns It, or `undefined` when no session answers or it has no Studio.
 */
async function sessionTargetAsync(context: CommandContext): Promise<StudioTarget | undefined> {
	const session = findSession(context.seams.fileSystem, forgeFiles(context.cwd));
	const studio =
		session === undefined ? undefined : await waitForSessionStudioAsync(context.seams, session);
	return studio === undefined ? undefined : sessionStudioTarget(studio);
}

/**
 * The result of `forge stop` once Studio is gone.
 *
 * @param stop - How Studio went.
 * @param place - The absolute path of the place file.
 * @returns Its data and summary.
 */
function stoppedResult(
	{ end, forced: isForced, pid, recovery }: Extract<StudioStop, { status: "stopped" }>,
	place: string,
): CommandResult {
	return {
		data: { end, forced: isForced, pid, place, recovery, stopped: true },
		summary: `Stopped Roblox Studio (PID ${pid}) for ${place}${HOW[end]}.`,
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
