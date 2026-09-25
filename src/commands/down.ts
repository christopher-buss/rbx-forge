import type { FlagDefinition, FlagValues } from "../cli/flags.ts";
import type { DownStudio, StoppedBy } from "../client/down.ts";
import { DOWN_TIMEOUT_MS, stopSessionAsync } from "../client/down.ts";
import { findSession } from "../client/session.ts";
import { ForgeError } from "../errors.ts";
import type { CommandResult } from "../seams/reporter.ts";
import { STUDIO_CLOSE_MS } from "../studio/close-studio.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const DOWN_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "force",
		kind: "boolean",
		text: "Kill a supervisor that does not stop, and what is left of its session, each verified as the session's own.",
	},
	{
		name: "keep-studio",
		kind: "boolean",
		text: "Leave the session's Roblox Studio open. By default down closes it, and ends it without a save when it does not close in time.",
	},
	{
		name: "timeout",
		kind: "number",
		text: `How long to wait for the session to stop, and for its processes to be gone (default ${DOWN_TIMEOUT_MS / 1000}).`,
		value: "<seconds>",
	},
];

/** The summary's first words when the session stopped as asked. */
const STOPPED = "Stopped session";

/** The first words of the summary, by how the supervisor went. */
const HOW: Readonly<Record<StoppedBy, string>> = {
	forced_shutdown: STOPPED,
	gone: "Cleaned up after session",
	killed: "Killed the supervisor of session",
	shutdown: STOPPED,
	studio_closed: STOPPED,
};

/**
 * `forge down`: stop the project's session and prove it gone. First it
 * closes the session's Studio, unless `--keep-studio`; a Studio forge cannot
 * close is reported in `studio`, and the session still stops. It reports
 * `stopped` only once the session's supervisor has exited and none of its
 * processes is left. It escalates from a shutdown request to a forced one;
 * with `--force`, it then kills the supervisor through a pinned,
 * start-time-verified handle and cleans up what is left of the session. It
 * only acts on the session `.forge/current` named when it began.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param input - `--force`, `--keep-studio`, and `--timeout`.
 * @returns The stopped session's id, how it stopped, what happened to its
 *   Studio, and any cleanup.
 * @rejects {ForgeError} `not_running` when no session is named;
 *   `session_replaced`; `supervisor_unresponsive`; `cleanup_in_progress`;
 *   `cleanup_unverifiable`; `usage` for a bad `--timeout`.
 */
export async function runDownAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const timeoutMs = timeoutOf(input.flags["timeout"]);
	const forge = forgeFiles(context.cwd);
	const session = findSession(context.seams.fileSystem, forge);
	if (session === undefined) {
		throw new ForgeError("not_running", "No session runs for this project.", {
			hint: 'Start one with "forge up".',
		});
	}

	const report = await stopSessionAsync(context.seams, forge, session, {
		force: input.flags["force"] === true,
		keepStudio: input.flags["keep-studio"] === true,
		timeoutMs,
	});
	return {
		data: { ...report, status: "stopped" },
		summary: `${HOW[report.stoppedBy]} ${report.sessionId}; every process of it is gone.${studioSentence(report.studio)}`,
	};
}

/**
 * The sentence the summary gives Studio.
 *
 * @param studio - What `down` did with the session's Studio.
 * @returns The sentence, with a leading space; empty when there is nothing
 *   to say.
 */
function studioSentence(studio: DownStudio): string {
	switch (studio.status) {
		case "closed": {
			return studio.forced
				? ` Roblox Studio (PID ${studio.pid}) did not close within ${STUDIO_CLOSE_MS / 1000} s, so forge ended it without saving.`
				: ` Closed Roblox Studio (PID ${studio.pid}).`;
		}
		case "failed": {
			return ` Roblox Studio may still have ${studio.place} open: ${studio.message}`;
		}
		case "kept": {
			return " Roblox Studio stays open.";
		}
		case "none":
		case "unknown": {
			return "";
		}
	}
}

/**
 * The wait `--timeout` asks for.
 *
 * @param value - The flag's value, in seconds.
 * @returns Milliseconds; {@link DOWN_TIMEOUT_MS} when the flag is absent.
 * @throws {ForgeError} `usage` when it is not a number of seconds.
 */
function timeoutOf(value: FlagValues[string]): number {
	if (value === undefined) {
		return DOWN_TIMEOUT_MS;
	}

	const seconds = typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
	if (!Number.isFinite(seconds) || seconds < 0) {
		throw new ForgeError(
			"usage",
			`--timeout takes a number of seconds, not "${String(value)}".`,
		);
	}

	return seconds * 1000;
}
