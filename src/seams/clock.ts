import { setTimeout as sleep } from "node:timers/promises";

/**
 * Time, for timeouts, durations, and timestamps. Unit tests pass a fake that
 * advances only when told (`test/helpers/seams.ts`).
 */
export interface Clock {
	/** Milliseconds since the Unix epoch. */
	now: () => number;
	/**
	 * Wait `ms` milliseconds. Rejects with an `AbortError` when `signal`
	 * aborts first.
	 */
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const nodeClock: Clock = {
	now: () => Date.now(),
	sleep: async (ms, signal) => {
		await sleep(ms, undefined, { signal });
	},
};

/** A wait nothing ends early. */
const NEVER = AbortSignal.any([]);

/**
 * Whether `promise` settles within `ms`.
 *
 * @param clock - Runs the timer.
 * @param promise - What to wait for; it never rejects.
 * @param ms - The limit.
 * @param hurry - Ends the wait early, as if the limit passed.
 * @returns `true` when it settled first.
 */
export async function settlesWithinAsync(
	clock: Clock,
	promise: Promise<unknown>,
	ms: number,
	hurry: AbortSignal = NEVER,
): Promise<boolean> {
	const abort = new AbortController();
	// The timer rejects once the abort fires: after the race settled, which
	// ignores it, or on `hurry`, which ends the wait.
	const timer = clock
		.sleep(ms, AbortSignal.any([abort.signal, hurry]))
		.then(() => false)
		.catch(() => false);
	const hasSettled = await Promise.race([promise.then(() => true), timer]);
	abort.abort();
	return hasSettled;
}
