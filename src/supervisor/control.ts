import { ForgeError } from "../errors.ts";
import type { IpcServerOptions } from "../ipc/server.ts";
import type { SessionSync } from "../session/session-sync.ts";
import type { StatusStore } from "../session/status.ts";
import type { StopSource } from "../session/stop-source.ts";

/** What the control channel of one session reaches. */
export interface ControlTarget {
	sessionId: string;
	status: Pick<StatusStore, "snapshot">;
	stop: Pick<StopSource, "request">;
	sync: Pick<SessionSync, "runAsync">;
}

/**
 * The methods a session serves on its control channel:
 *
 * - `status`: the state contract (`session/status.ts`).
 * - `shutdown`: stop the session through its single shutdown path. Answers
 *   at once; the caller waits for the session to be gone. With a
 *   `sessionId` param, only that session stops: another one answers
 *   `session_replaced`. With `force: true`, the workers get no more grace,
 *   also when the session is already stopping (`forge down`, step 2).
 *
 * - `sync`: run syncback with its hooks in the session, one run at a time
 *   with the save watch. Answers once the run ended,
 *   with what was synced and each hook result, or with the run's failure.
 *
 * @param target - The session's id, status, stop requests, and syncback.
 * @returns The `status`, `sync`, and `shutdown` handlers of the session.
 */
export function controlHandlers(target: ControlTarget): IpcServerOptions["handlers"] {
	return {
		shutdown: (parameters) => {
			const wanted = parameters["sessionId"];
			if (typeof wanted === "string" && wanted !== target.sessionId) {
				throw new ForgeError(
					"session_replaced",
					`Session ${wanted} is gone; session ${target.sessionId} runs in its place.`,
					{ details: { sessionId: target.sessionId } },
				);
			}

			const isForced = parameters["force"] === true;
			target.stop.request(
				isForced ? { force: true, type: "shutdown" } : { type: "shutdown" },
			);
			return { accepted: true, sessionId: target.sessionId };
		},
		status: () => ({ ...target.status.snapshot() }),
		sync: async () => target.sync.runAsync(),
	};
}
