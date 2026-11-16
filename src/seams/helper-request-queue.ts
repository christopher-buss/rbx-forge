import { ForgeError } from "../errors.ts";
import type { Clock } from "./clock.ts";

/** The native helper executes one request at a time. */
export class HelperRequestQueue {
	private readonly clock: Clock;

	private tail: Promise<void> | undefined;

	constructor(clock: Clock) {
		this.clock = clock;
	}

	public async runAsync<T>(
		work: (remainingMs: number) => Promise<T>,
		timeoutMs: number,
	): Promise<T> {
		const deadline = this.clock.now() + timeoutMs;
		const { previous, release } = this.enqueue();
		try {
			if (previous !== undefined) {
				await this.waitAsync(previous, timeoutMs);
			}

			const remaining = deadline - this.clock.now();
			if (remaining <= 0) {
				throw busy();
			}

			return await work(remaining);
		} finally {
			release();
		}
	}

	private enqueue(): { previous: Promise<void> | undefined; release: () => void } {
		const previous = this.tail;
		const finished = Promise.withResolvers<void>();
		const current =
			previous === undefined ? finished.promise : previous.then(async () => finished.promise);
		this.tail = current;
		void current.then(() => {
			if (this.tail === current) {
				this.tail = undefined;
			}
		});
		return { previous, release: finished.resolve };
	}

	private async waitAsync(previous: Promise<void>, timeoutMs: number): Promise<void> {
		const abort = new AbortController();
		const timeout = this.clock.sleep(timeoutMs, abort.signal).then(() => {
			throw busy();
		});
		try {
			await Promise.race([previous, timeout]);
		} finally {
			abort.abort();
		}
	}
}

function busy(): ForgeError {
	return new ForgeError(
		"windows_helper_unavailable",
		"Windows helper is busy with another operation.",
	);
}
