import path from "node:path";

import type { FlagDefinition, FlagValues } from "../cli/flags.ts";
import type { KnownSession } from "../client/session.ts";
import { fetchStatusAsync, findSession, stopPartsAsync } from "../client/session.ts";
import { RECOVERY_FLAG, recoveryOptions } from "../client/studio.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import type { AutoRecoveryMode } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { PartStops } from "../session/part-stops.ts";
import { STOP_PARTS_WAIT_MS } from "../session/part-stops.ts";
import type { SessionStudio } from "../session/status.ts";
import type { StudioEnd, StudioStop } from "../studio/close-studio.ts";
import { closeStudioAsync, STUDIO_CLOSE_MS } from "../studio/close-studio.ts";
import { failureError } from "../supervisor/channel.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const STOP_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "force",
		kind: "boolean",
		text: "Close a Studio that a forge start terminal owns too.",
	},
	{
		name: "place",
		kind: "string",
		text: "Close the Studio that has this place open (default: the session's Studio, else the project's place).",
		value: "<path>",
	},
	RECOVERY_FLAG,
];

/** How the summary tells how Studio went. */
const HOW: Readonly<Record<StudioEnd, string>> = {
	dialog: ": a dialog blocked it, so forge ended it without saving",
	exited: "",
	lock_released: "",
	no_window: ": it had no window to close, so forge ended it without saving",
	timeout: `: it did not close within ${STUDIO_CLOSE_MS / 1000} s, so forge ended it without saving`,
};

/** What `stop` asks a running session. */
interface SessionStop {
	force: boolean;
	place: string | undefined;
	recovery: AutoRecoveryMode;
}

/** What the project's session did with a stop, and its Studio before it. */
interface SessionAnswer {
	session: KnownSession;
	stops: PartStops;
	studio: SessionStudio;
}

/**
 * `forge stop`: close a Roblox Studio of this project. When a session runs,
 * it asks the session to close its Studio (waiting while it is still
 * opening) and stop that Studio's Rojo; the compiler keeps running, and a
 * session with no part left ends. A Studio that a `forge start` terminal
 * owns stays, unless `--force`. With no session Studio (or another place
 * in `--place`), it closes the Studio the place's lock file names. Studio
 * gets a close request; forge ends it once it closed the place, at once
 * when a dialog blocks it, and else after {@link STUDIO_CLOSE_MS}, without
 * a save (`closeStudioAsync`). It acts only on a Studio its identity check
 * verifies. The auto-recovery files of a Studio it ended are moved,
 * deleted, or kept (`studio.autoRecovery`, `--recovery`).
 *
 * @param context - The run: project directory, config loader, file system,
 *   clock, transport, and native addon.
 * @param input - `--force`, `--place`, and the config values flags set.
 * @returns Whether a Studio was stopped, its PID, the place, how it went,
 *   what forge did with its auto-recovery files, and the session's parts it
 *   stopped and kept (`null` with no session).
 * @rejects `studio_owned` when a `forge start` terminal owns the Studio;
 *   `identity_mismatch` when the lock file names no process or another
 *   computer, or a process that is not Studio, started after the lock file
 *   was written, is not the session's Studio, or cannot be checked;
 *   `process_failed` when Studio does not exit in time; config errors from
 *   `loadProjectConfigAsync`.
 */
export async function runStopAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const { cwd, env, seams } = context;
	const { config } = await loadProjectConfigAsync(cwd, seams.configLoader, input.config);
	const forge = forgeFiles(cwd);
	const request: SessionStop = {
		force: input.flags["force"] === true,
		place: placeOf(cwd, input.flags["place"]),
		recovery: config.studio.autoRecovery,
	};
	const answer = await askSessionAsync(context, request, config.gracefulTimeoutMs);
	const parts =
		answer === undefined ? null : { kept: answer.stops.kept, stopped: answer.stops.stopped };
	const outcome = answer?.stops.studio;
	if (outcome !== undefined) {
		if ("error" in outcome) {
			throw failureError(outcome.error);
		}

		return withParts(stopResult(outcome.stop, outcome.place), parts);
	}

	if (answer !== undefined) {
		requireUnowned(answer);
	}

	const place =
		request.place ?? path.resolve(cwd, config.open.buildOutputPath ?? config.buildOutputPath);
	const stop = await closeStudioAsync(seams, { place }, recoveryOptions(env, forge, config));
	return withParts(stopResult(stop, place), parts);
}

/**
 * The place `--place` names.
 *
 * @param cwd - The project root.
 * @param value - The flag's value.
 * @returns Its absolute path; `undefined` when the flag is absent.
 */
function placeOf(cwd: string, value: FlagValues[string]): string | undefined {
	return typeof value === "string" ? path.resolve(cwd, value) : undefined;
}

/**
 * Ask the project's running session to stop its Studio.
 *
 * @param context - The file system and transport.
 * @param request - `--force`, `--place`, and the recovery mode.
 * @param graceMs - How long the session's services get to stop.
 * @returns What it did, and its Studio before; `undefined` when no session
 *   answers, or it still starts or stops.
 * @rejects {ForgeError} `internal_error` when it answers with something
 *   else.
 */
async function askSessionAsync(
	context: CommandContext,
	request: SessionStop,
	graceMs: number,
): Promise<SessionAnswer | undefined> {
	const { fileSystem, ipc } = context.seams;
	const session = findSession(fileSystem, forgeFiles(context.cwd));
	if (session === undefined) {
		return undefined;
	}

	try {
		const { services } = await fetchStatusAsync(ipc, session);
		const stops = await stopPartsAsync(
			ipc,
			session,
			{ ...request, keepStudio: false, scope: "stop" },
			STOP_PARTS_WAIT_MS + graceMs,
		);
		return { session, stops, studio: services.studio };
	} catch (err) {
		if (err instanceof ForgeError && err.code === "internal_error") {
			throw err;
		}

		// Gone, silent, replaced, starting, or stopping: no session Studio.
		return undefined;
	}
}

/**
 * Fail when the session kept its Studio because it has an owner.
 *
 * @param answer - What the session did, and its Studio before.
 * @throws {ForgeError} `studio_owned`, naming the owner.
 */
function requireUnowned({ session, stops, studio }: SessionAnswer): void {
	const owned = stops.kept.find(({ part }) => part === "studio");
	if (owned === undefined) {
		return;
	}

	const { sessionId } = session.identity;
	const pid = studio.pid === undefined ? "" : ` (PID ${studio.pid})`;
	throw new ForgeError(
		"studio_owned",
		`Roblox Studio${pid} of session ${sessionId} has an owner: the forge ${owned.owner} terminal.`,
		{
			details: {
				owner: owned.owner,
				...(studio.pid === undefined ? {} : { pid: studio.pid }),
				...(studio.place === undefined ? {} : { place: studio.place }),
				sessionId,
			},
			hint: 'Close it in Studio, or run "forge stop --force".',
		},
	);
}

/**
 * Add the session's parts to a result.
 *
 * @param result - The Studio result.
 * @param parts - The parts the session stopped and kept; `null` with no
 *   session.
 * @returns The result with `parts` in its data.
 */
function withParts(
	result: CommandResult,
	parts: null | Pick<PartStops, "kept" | "stopped">,
): CommandResult {
	return { ...result, data: { ...result.data, parts } };
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
