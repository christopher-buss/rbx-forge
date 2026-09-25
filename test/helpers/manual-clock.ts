import type { Clock } from "../../src/seams/clock.ts";

/** A clock whose time and timers move only when the test says so. */
export interface ManualClock {
	/** Move time forward and fire every timer that is due. */
	advance: (ms: number) => void;
	clock: Clock;
	/** Timers that have not fired or been aborted. */
	pending: () => number;
}

interface Timer {
	at: number;
	resolve: () => void;
}

/**
 * Make a clock that starts at `start` and stands still until `advance`.
 *
 * @param start - Milliseconds since the epoch at the start.
 * @returns The clock and its controls.
 */
export function createManualClock(start = 0): ManualClock {
	let now = start;
	let timers: Array<Timer> = [];

	return {
		advance: (ms) => {
			now += ms;
			const due = timers.filter(({ at }) => at <= now);
			timers = timers.filter(({ at }) => at > now);
			for (const { resolve } of due) {
				resolve();
			}
		},
		clock: {
			now: () => now,
			sleep: async (ms, signal) => {
				// As `timers/promises`: an aborted signal rejects at once.
				signal?.throwIfAborted();
				return new Promise((resolve, reject) => {
					const timer = { at: now + ms, resolve };
					timers.push(timer);
					signal?.addEventListener("abort", () => {
						timers = timers.filter((other) => other !== timer);
						reject(new DOMException("The operation was aborted", "AbortError"));
					});
				});
			},
		},
		pending: () => timers.length,
	};
}
