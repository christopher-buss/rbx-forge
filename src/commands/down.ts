import type { FlagDefinition, FlagValues } from "../cli/flags.ts";
import { readCountFlag } from "../cli/flags.ts";
import type { DownStudio } from "../client/down-parts.ts";
import type { DownReport, StoppedBy } from "../client/down.ts";
import { DOWN_TIMEOUT_MS, stopSessionAsync } from "../client/down.ts";
import { findSession } from "../client/session.ts";
import { RECOVERY_FLAG } from "../client/studio.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { DEFAULT_CONFIG } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { KeptPart } from "../session/part-stops.ts";
import type { PartId } from "../session/status.ts";
import type { StudioEnd } from "../studio/close-studio.ts";
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
		text: "Leave the session's Roblox Studio open. By default down closes it, and ends it without a save when a dialog blocks it or it does not close in time.",
	},
	RECOVERY_FLAG,
	{
		name: "timeout",
		kind: "number",
		text: `How long to wait for the session to stop, and for its processes to be gone (default ${DOWN_TIMEOUT_MS / 1000}).`,
		value: "<seconds>",
	},
];

/** How the summary tells how Studio went, by how it was ended. */
const ENDED: Readonly<Record<Exclude<StudioEnd, "exited" | "lock_released">, string>> = {
	dialog: "a dialog blocked it",
	no_window: "it had no window to close",
	timeout: `it did not close within ${STUDIO_CLOSE_MS / 1000} s`,
};

/** The summary's first words when the session stopped as asked. */
const STOPPED = "Stopped session";

/** The first words of the summary, by how the supervisor went. */
const HOW: Readonly<Record<StoppedBy, string>> = {
	forced_shutdown: STOPPED,
	gone: "Cleaned up after session",
	killed: "Killed the supervisor of session",
	shutdown: STOPPED,
};

/** How the summary names each part. */
const PART_NAMES: Readonly<Record<PartId, string>> = {
	compiler: "the compiler",
	rojo: "Rojo",
	studio: "Studio",
};

/**
 * Name parts in a list, such as `Studio, Rojo, and the compiler`.
 *
 * @param parts - The parts, in order.
 * @returns Their names, joined for a sentence.
 */
export function listParts(parts: ReadonlyArray<PartId>): string {
	const names = parts.map((part) => PART_NAMES[part]);
	const last = names.pop();
	if (names.length === 0) {
		return String(last);
	}

	return `${names.join(", ")}${names.length > 1 ? "," : ""} and ${last}`;
}

/**
 * `forge down`: stop the parts of the project's session that have no owner
 * and, once none is left, prove the session gone. The session closes its
 * Studio first, unless `--keep-studio`; a Studio forge cannot close is
 * reported in `studio`, and the session still stops. Parts with an owner
 * (a `forge start` terminal) keep running, and so does the session: `down`
 * reports them in `parts.kept` and never fails because of them. It reports
 * `stopped` only once the session's supervisor has exited and none of its
 * processes is left. It escalates from a shutdown request to a forced one;
 * with `--force`, it then kills the supervisor through a pinned,
 * start-time-verified handle and cleans up what is left of the session. It
 * only acts on the session `.forge/current` named when it began.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param input - `--force`, `--keep-studio`, `--recovery`, and `--timeout`.
 * @returns The session's id, whether it stopped, the parts it stopped and
 *   kept, how the session stopped, what happened to its Studio, and any
 *   cleanup.
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

	const { studio } = await studioConfigAsync(context, input);
	const report = await stopSessionAsync(context.seams, forge, session, {
		force: input.flags["force"] === true,
		keepStudio: input.flags["keep-studio"] === true,
		recovery: studio.autoRecovery,
		timeoutMs,
	});
	return { data: { ...report }, summary: downSummary(report) };
}

/**
 * Say which parts stay, and who owns them.
 *
 * @param kept - The parts with an owner.
 * @returns The end of the sentence that says the session goes on.
 */
function keptSentence(kept: ReadonlyArray<KeptPart>): string {
	if (kept.length === 0) {
		return ".";
	}

	const verb = kept.length === 1 ? "has" : "have";
	const names = listParts(kept.map(({ part }) => part));
	return `: ${names} ${verb} an owner, the forge start terminal.`;
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
			return studio.end === "exited" || studio.end === "lock_released"
				? ` Closed Roblox Studio (PID ${studio.pid}).`
				: ` Roblox Studio (PID ${studio.pid}): ${ENDED[studio.end]}, so forge ended it without saving.`;
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
 * The summary line of a `down` result.
 *
 * @param report - The session, its parts, and how it stopped.
 * @returns How the session went, then its Studio.
 */
function downSummary(report: DownReport): string {
	const { sessionId } = report;
	if (report.status === "stopped") {
		const empty = report.parts?.stopped.length === 0 ? " It had no part to stop." : "";
		return `${HOW[report.stoppedBy]} ${sessionId}; every process of it is gone.${empty}${studioSentence(report.studio)}`;
	}

	const { parts } = report;
	const stopped = parts.stopped.length === 0 ? "no part" : listParts(parts.stopped);
	return `Stopped ${stopped} of session ${sessionId}. It goes on${keptSentence(parts.kept)}${studioSentence(report.studio)}`;
}

/**
 * The Studio options of the project. `down` must stop a session also when
 * the config file is gone or broken: then only `--recovery` and the
 * defaults count.
 *
 * @param context - The project root and config loader.
 * @param input - The config values flags set.
 * @returns The resolved `studio` options.
 */
async function studioConfigAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<Pick<ResolvedConfig, "studio">> {
	try {
		const { config } = await loadProjectConfigAsync(
			context.cwd,
			context.seams.configLoader,
			input.config,
		);
		return config;
	} catch {
		return { studio: { ...DEFAULT_CONFIG.studio, ...input.config.studio } };
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

	return readCountFlag("timeout", value, "seconds") * 1000;
}
