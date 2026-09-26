import type { CommandResult } from "../seams/reporter.ts";
import { releasedResult } from "../session/ownership.ts";
import type { PartRequests } from "../session/part-requests.ts";
import type { OnStop, StopSource } from "../session/stop-source.ts";

/** The `forge start` that owns a session it started, over its owner pipe. */
export interface SupervisorOwner {
	/**
	 * Its end: Ctrl+C, a closed terminal, or its death. The parts it owns
	 * stop, and the session ends unless a part with no owner runs on.
	 */
	onEnd: OnStop;
	/**
	 * Called when its end left the session running: `start` may return with
	 * this result.
	 */
	onReleased: (result: CommandResult) => void;
}

/**
 * Route the end of the `start` that started the session to its parts: the
 * session lets go of what `start` owns, and `start` hears of it when the
 * session runs on. A session that cannot let go yet (it has not started
 * its parts) or any more (it is stopping) stops whole.
 *
 * @template T - The part requests' type.
 * @param owner - The `start` that started the session, if one did.
 * @param stop - The run's stop requests.
 * @param parts - The session's part requests.
 * @returns The same part requests.
 */
export function watchOwnerEnd<T extends Pick<PartRequests, "releaseAsync">>(
	owner: SupervisorOwner | undefined,
	stop: StopSource,
	parts: T,
): T {
	owner?.onEnd((request) => {
		parts
			.releaseAsync(request)
			.then((released) => {
				if (!released.ending) {
					owner.onReleased(releasedResult(released));
				}
			})
			.catch(() => {
				stop.request(request);
			});
	});
	return parts;
}
