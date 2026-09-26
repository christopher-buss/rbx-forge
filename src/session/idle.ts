import type { Clock } from "../seams/clock.ts";
import type { Reporter } from "../seams/reporter.ts";
import type { PartStopper, StopPartsRequest } from "./part-stops.ts";

const MINUTE_MS = 60_000;

/**
 * The stop the idle timeout asks for: every part with no owner, Studio
 * included, as `down` does. An `up` session with no part left ends.
 */
export const IDLE_STOP: StopPartsRequest = { force: false, keepStudio: false, scope: "down" };

/**
 * When a session is idle: `session.idleTimeout` minutes after its last
 * activity (a client request, a compile start, or a Studio save).
 */
export interface IdleTracker {
	/** Activity at `now`: the time starts again. */
	activity: (now: number) => void;
	/** When the session is idle; `undefined` when the timeout is off. */
	idleAt: () => number | undefined;
}

/** What the idle watch runs with. */
export interface IdleSetup {
	clock: Clock;
	idle: IdleTracker;
	/** The timeout, for the report. */
	minutes: number;
	reporter: Pick<Reporter, "emit">;
	/** Stops parts through the session's request queue. */
	stopAsync: PartStopper;
}

/**
 * Make the idle tracker of a session.
 *
 * @param minutes - `session.idleTimeout`; 0 turns it off.
 * @param now - The session's start: the first activity.
 * @returns A tracker.
 */
export function createIdleTracker(minutes: number, now: number): IdleTracker {
	let last = now;
	return {
		activity: (at) => {
			last = at;
		},
		idleAt: () => (minutes > 0 ? last + minutes * MINUTE_MS : undefined),
	};
}

/**
 * Stop the parts with no owner each time the session is idle, until the
 * session ends. A stop starts the time again: parts added later get the
 * whole timeout.
 *
 * @param setup - The clock, tracker, reporter, and stopper.
 * @param signal - The session's end.
 */
export async function stopWhenIdleAsync(setup: IdleSetup, signal: AbortSignal): Promise<void> {
	const { clock, idle } = setup;
	for (;;) {
		const at = idle.idleAt();
		if (at === undefined || signal.aborted) {
			return;
		}

		const now = clock.now();
		if (now < at) {
			try {
				await clock.sleep(at - now, signal);
			} catch {
				// The session ended: the next look returns.
			}
		} else {
			await stopIdleAsync(setup);
			idle.activity(clock.now());
		}
	}
}

/**
 * One idle stop. A session that is stopping stops no part.
 *
 * @param setup - The reporter and stopper.
 */
async function stopIdleAsync({ minutes, reporter, stopAsync }: IdleSetup): Promise<void> {
	let stopped;
	try {
		({ stopped } = await stopAsync(IDLE_STOP));
	} catch {
		// `not_running`: the session is stopping.
		return;
	}

	if (stopped.length > 0) {
		reporter.emit({
			message: `No activity for ${minutes} min: stopped ${stopped.join(", ")}.`,
			type: "info",
		});
	}
}
