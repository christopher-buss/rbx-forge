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
