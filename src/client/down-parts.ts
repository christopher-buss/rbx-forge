import type { AutoRecoveryMode } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import { callSessionAsync } from "../ipc/client.ts";
import type { IpcTransport } from "../ipc/transport.ts";
import type { KeptPart, PartStops } from "../session/part-stops.ts";
import { STOP_PARTS_WAIT_MS } from "../session/part-stops.ts";
import type { PartId } from "../session/status.ts";
import { parseStatus } from "../session/status.ts";
import type { RecoveryReport } from "../studio/auto-recovery.ts";
import type { StudioEnd, StudioStop } from "../studio/close-studio.ts";
import type { KnownSession } from "./session.ts";
import { stopPartsAsync } from "./session.ts";

/**
 * What `down` did with the session's Studio:
 *
 * - `closed`: Studio is gone. `end`: how (see `StudioEnd`). `forced`:
 *   forge ended it with the place open, without a save. `recovery`: what
 *   forge did with its auto-recovery files; `null` when it ended none.
 * - `failed`: forge could not verify or end it (the error's `code` and
 *   `message`); Studio may still be open.
 * - `kept`: `--keep-studio` left it as it is, or it has an owner.
 * - `none`: the session has no Studio open.
 * - `unknown`: the supervisor did not answer, or was still starting, so
 *   forge cannot tell which Studio is the session's; it touched none.
 */
export type DownStudio =
	| { code: string; message: string; place: string; status: "failed" }
	| {
			end: StudioEnd;
			forced: boolean;
			pid: number;
			place: string;
			recovery: null | RecoveryReport;
			status: "closed";
	  }
	| { status: "kept" | "none" | "unknown" };

/**
 * The parts `down` stopped, and those it kept because they have an owner;
 * `null` when the session did not say (it did not answer, or was still
 * starting), and `down` stopped it whole.
 */
export type DownParts = null | { kept: Array<KeptPart>; stopped: Array<PartId> };

/** How `down` asks a session to stop its parts. */
export interface PartStopOptions {
	/** `--keep-studio`: leave the session's Studio open. */
	keepStudio: boolean;
	/** What to do with the auto-recovery files of a Studio the session ends. */
	recovery: AutoRecoveryMode;
	/** How long `down` waits for the services, beyond the Studio bounds. */
	timeoutMs: number;
}

/**
 * Ask the session to stop its parts with no owner, once. A session that
 * does not answer its status first is not asked: a hung one would hold
 * `down` up for the whole stop wait.
 *
 * @param ipc - Reaches the session.
 * @param session - Its endpoint, token, and id.
 * @param options - `keepStudio`, the recovery mode, and the wait.
 * @returns What it stopped; `undefined` when it did not say.
 * @rejects {ForgeError} `session_replaced`.
 */
export async function askPartStopsAsync(
	ipc: IpcTransport,
	session: KnownSession,
	{ keepStudio, recovery, timeoutMs }: PartStopOptions,
): Promise<PartStops | undefined> {
	if (!(await isAnsweringAsync(ipc, session))) {
		return undefined;
	}

	try {
		return await stopPartsAsync(
			ipc,
			session,
			{ force: false, keepStudio, recovery, scope: "down" },
			STOP_PARTS_WAIT_MS + timeoutMs,
		);
	} catch (err) {
		if (err instanceof ForgeError && err.code === "session_replaced") {
			throw err;
		}

		// Starting, stopping, silent, or older: stop it whole.
		return undefined;
	}
}

/**
 * What `down` reports for the session's Studio.
 *
 * @param stops - What the session stopped; `undefined` when it did not say.
 * @param keepStudio - Whether `--keep-studio` left it open.
 * @returns What happened to Studio.
 */
export function downStudio(stops: PartStops | undefined, keepStudio: boolean): DownStudio {
	if (stops === undefined) {
		return { status: "unknown" };
	}

	const { studio } = stops;
	if (studio === undefined) {
		const isKept = keepStudio || stops.kept.some(({ part }) => part === "studio");
		return { status: isKept ? "kept" : "none" };
	}

	if ("error" in studio) {
		const { code, message } = studio.error;
		return { code, message, place: studio.place, status: "failed" };
	}

	return closedStudio(studio.stop, studio.place);
}

/**
 * Ask a session for its status once.
 *
 * @param ipc - Reaches the session.
 * @param session - Its endpoint, token, and id.
 * @returns Whether it answered as this session.
 */
async function isAnsweringAsync(
	ipc: IpcTransport,
	{ identity, token }: KnownSession,
): Promise<boolean> {
	try {
		const status = parseStatus(
			await callSessionAsync(ipc, { endpoint: identity.endpoint, token }, "status"),
		);
		return status?.sessionId === identity.sessionId;
	} catch {
		return false;
	}
}

/**
 * What `down` reports for a Studio it closed.
 *
 * @param stop - What closing it did.
 * @param place - Its place.
 * @returns `closed`, or `none` when it was not open.
 */
function closedStudio(stop: StudioStop, place: string): DownStudio {
	if (stop.status !== "stopped") {
		return { status: "none" };
	}

	return {
		end: stop.end,
		forced: stop.forced,
		pid: stop.pid,
		place,
		recovery: stop.recovery,
		status: "closed",
	};
}
