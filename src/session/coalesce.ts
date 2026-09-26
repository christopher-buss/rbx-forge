/**
 * Runs a task one at a time, folding requests that arrive meanwhile.
 *
 * @template T - What one run resolves with.
 */
export interface CoalescingRunner<T> {
	/**
	 * Ask for a run. When none runs, one starts now. When one runs, one more
	 * runs after it, however many requests arrive meanwhile.
	 *
	 * @returns The result of the run that starts at or after this request.
	 */
	request: () => Promise<T>;
	/** Resolves once no run is going or waiting. */
	settled: () => Promise<void>;
}

/**
 * What one {@link CoalescingRunner} tracks.
 *
 * @template T - What one run resolves with.
 */
interface CoalescingState<T> {
	/** The run after the one going, once a request asked for it. */
	pending: PromiseWithResolvers<T> | undefined;
	/** The loop of runs, while one is going. */
	running: Promise<void> | undefined;
}

/**
 * Make a runner that never overlaps `task` and keeps at most one run
 * pending, such as syncback on Studio saves and `forge sync`.
 *
 * @template T - What one run resolves with.
 * @param task - Does one run; it must not reject.
 * @returns Its `request` and `settled` functions.
 */
export function createCoalescingRunner<T>(task: () => Promise<T>): CoalescingRunner<T> {
	const state: CoalescingState<T> = { pending: undefined, running: undefined };

	return {
		request: async () => {
			if (state.running === undefined) {
				const first = Promise.withResolvers<T>();
				state.running = loopAsync(state, task, first);
				return first.promise;
			}

			state.pending ??= Promise.withResolvers<T>();
			return state.pending.promise;
		},
		settled: async () => {
			await state.running;
		},
	};
}

/**
 * Take the pending run, if any.
 *
 * @template T - What one run resolves with.
 * @param state - The runner's state.
 * @returns The run a request asked for, or `undefined`.
 */
function takePending<T>(state: CoalescingState<T>): PromiseWithResolvers<T> | undefined {
	const { pending } = state;
	state.pending = undefined;
	return pending;
}

async function loopAsync<T>(
	state: CoalescingState<T>,
	task: () => Promise<T>,
	first: PromiseWithResolvers<T>,
): Promise<void> {
	let run: PromiseWithResolvers<T> | undefined = first;
	while (run !== undefined) {
		run.resolve(await task());
		run = takePending(state);
	}

	state.running = undefined;
}
