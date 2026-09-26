import { ForgeError } from "../errors.ts";
import type { IpcOwner, IpcServerOptions } from "../ipc/server.ts";
import type { BuildWatch } from "../session/build-watch.ts";
import { FRESH_BUILD_TIMEOUT_MS } from "../session/build-watch.ts";
import type { PartRequests } from "../session/part-requests.ts";
import { parsePartRequest } from "../session/part-requests.ts";
import { parseRestartRequest, parseStopRequest } from "../session/part-stop-schema.ts";
import type { SessionSync } from "../session/session-sync.ts";
import type { StatusStore } from "../session/status.ts";
import type { StopSource } from "../session/stop-source.ts";

/** What the control channel of one session reaches. */
export interface ControlTarget {
	builds: Pick<BuildWatch, "tick" | "waitAsync">;
	parts: Pick<
		PartRequests,
		"addAsync" | "ownAsync" | "releaseAsync" | "restartAsync" | "stopAsync"
	>;
	sessionId: string;
	status: Pick<StatusStore, "snapshot">;
	stop: Pick<StopSource, "request">;
	sync: Pick<SessionSync, "runAsync">;
}

/**
 * The methods a session serves on its control channel:
 *
 * - `addParts`: start the parts in the `parts` param (`compiler`, `studio`)
 *   that are missing or failed; a part that runs is never touched. `studio`
 *   attaches Studio (started with the `studioPath` param, if any) with its
 *   Rojo. Waits until the session has started its own parts, and answers
 *   once the new ones run (Rojo listens, Studio has the place open), with
 *   `added`: the parts it started.
 * - `restartParts`: stop the parts `stopParts` stops in the `restart`
 *   scope (with the `force` and `recovery` params), then start them again
 *   as `addParts` does (Studio with the `studioPath` param, if any), each
 *   with the owner it had. Answers once they run, with `stopped`, `kept`,
 *   `studio`, and `added`; with `cleanup_in_progress`, having started
 *   nothing, when a stopped service's tree is not proven gone. A
 *   `sessionId` param works as for `shutdown`.
 * - `status`: the state contract (`session/status.ts`).
 * - `freshStatus`: the state contract once the compiler's last build is
 *   fresh (`session/build-watch.ts`), waiting up to the `timeoutMs` param
 *   ({@link FRESH_BUILD_TIMEOUT_MS} when absent).
 * - `shutdown`: stop the session through its single shutdown path. Answers
 *   at once; the caller waits for the session to be gone. With a
 *   `sessionId` param, only that session stops: another one answers
 *   `session_replaced`. With `force: true`, the workers get no more grace,
 *   also when the session is already stopping (`forge down`, step 2).
 *
 * - `stopParts`: stop the running parts the `scope` param reaches (`down`,
 *   `stop`, `restart`) that have no owner; with `force: true` the owned
 *   ones too. `stop` reaches the Studio of the `place` param (any when
 *   unset) and its Rojo; `keepStudio: true` leaves Studio open for `down`.
 *   A closed Studio's auto-recovery files go as the `recovery` param says.
 *   Answers once they are gone, with `stopped`, `kept` (with each owner),
 *   `studio` (what closing Studio did), and `ending`: no part is left, so
 *   the session ends. A `sessionId` param works as for `shutdown`.
 * - `sync`: run syncback with its hooks in the session, one run at a time
 *   with the save watch. Answers once the run ended,
 *   with what was synced and each hook result, or with the run's failure.
 *
 * @param target - The session's builds, parts, id, status, stop requests,
 *   and syncback.
 * @returns The handlers of the session.
 */
export function controlHandlers(target: ControlTarget): IpcServerOptions["handlers"] {
	return {
		addParts: async (parameters) => addPartsAsync(target, parameters),
		freshStatus: async ({ timeoutMs }) => {
			await target.builds.waitAsync(
				typeof timeoutMs === "number" && timeoutMs >= 0
					? timeoutMs
					: FRESH_BUILD_TIMEOUT_MS,
			);
			return snapshot(target);
		},
		restartParts: async (parameters) => restartPartsAsync(target, parameters),
		shutdown: (parameters) => {
			requireSession(target, parameters);
			const isForced = parameters["force"] === true;
			target.stop.request(
				isForced ? { force: true, type: "shutdown" } : { type: "shutdown" },
			);
			return { accepted: true, sessionId: target.sessionId };
		},
		status: () => snapshot(target),
		stopParts: async (parameters) => {
			requireSession(target, parameters);
			return { ...(await target.parts.stopAsync(parseStopRequest(parameters))) };
		},
		sync: async () => target.sync.runAsync(),
	};
}

/**
 * How a session serves `own`: a `forge start` joins as its owner and holds
 * the connection. The join takes every running part (only the compiler
 * when `parts` has no Studio), and starts the parts in the `parts` param
 * (as `addParts`); it answers with `sessionId`,
 * `taken`, and `added`, or `session_running` while another `start` owns the
 * session. A release, or the connection's end, stops what it started and
 * gives back what it took; a release is answered with `stopped`,
 * `released`, `studioLeft`, and `ending`.
 *
 * @param target - The session's parts and id.
 * @returns The owner handlers of the session.
 */
export function controlOwner(target: Pick<ControlTarget, "parts" | "sessionId">): IpcOwner {
	return {
		join: async (parameters) => {
			const joined = await target.parts.ownAsync(parsePartRequest(parameters));
			return { ...joined, sessionId: target.sessionId };
		},
		leave: async () => ({ ...(await target.parts.releaseAsync({ type: "owner_gone" })) }),
	};
}

/**
 * Check that a request is for this session.
 *
 * @param target - Holds this session's id.
 * @param parameters - The request's params, with an optional `sessionId`.
 * @throws {ForgeError} `session_replaced` when it names another session.
 */
function requireSession(target: ControlTarget, parameters: Record<string, unknown>): void {
	const wanted = parameters["sessionId"];
	if (typeof wanted === "string" && wanted !== target.sessionId) {
		throw new ForgeError(
			"session_replaced",
			`Session ${wanted} is gone; session ${target.sessionId} runs in its place.`,
			{ details: { sessionId: target.sessionId } },
		);
	}
}

async function addPartsAsync(
	target: ControlTarget,
	parameters: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const added = await target.parts.addAsync(parsePartRequest(parameters));
	return { added };
}

async function restartPartsAsync(
	target: ControlTarget,
	parameters: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	requireSession(target, parameters);
	return { ...(await target.parts.restartAsync(parseRestartRequest(parameters))) };
}

function snapshot({ builds, status }: ControlTarget): Record<string, unknown> {
	// Start lines that one summary line ended may have settled meanwhile.
	builds.tick();
	return { ...status.snapshot() };
}
