import { ForgeError } from "../errors.ts";
import type { IpcServerOptions } from "../ipc/server.ts";
import type { BuildWatch } from "../session/build-watch.ts";
import { FRESH_BUILD_TIMEOUT_MS } from "../session/build-watch.ts";
import type { PartRequests } from "../session/part-requests.ts";
import { parsePartRequest } from "../session/part-requests.ts";
import type { SessionSync } from "../session/session-sync.ts";
import type { StatusStore } from "../session/status.ts";
import type { StopSource } from "../session/stop-source.ts";

/** What the control channel of one session reaches. */
export interface ControlTarget {
	builds: Pick<BuildWatch, "tick" | "waitAsync">;
	parts: Pick<PartRequests, "addAsync">;
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
		status: () => snapshot(target),
		sync: async () => target.sync.runAsync(),
	};
}

async function addPartsAsync(
	target: ControlTarget,
	parameters: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const added = await target.parts.addAsync(parsePartRequest(parameters));
	return { added };
}

function snapshot({ builds, status }: ControlTarget): Record<string, unknown> {
	// Start lines that one summary line ended may have settled meanwhile.
	builds.tick();
	return { ...status.snapshot() };
}
