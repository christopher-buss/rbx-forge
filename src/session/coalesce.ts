/** Runs a task one at a time, folding requests that arrive meanwhile. */
export interface CoalescingRunner {
	/**
	 * Ask for a run. When none runs, one starts now. When one runs, one more
	 * runs after it, however many requests arrive meanwhile.
	 */
	request: () => void;
	/** Resolves once no run is going or waiting. */
	settled: () => Promise<void>;
}

/** What one {@link CoalescingRunner} tracks. */
interface CoalescingState {
	/** A request arrived during the run that is going. */
	isPending: boolean;
	/** The loop of runs, while one is going. */
	running: Promise<void> | undefined;
}

/**
 * Make a runner that never overlaps `task` and keeps at most one run
 * pending, such as syncback on Studio saves.
 *
 * @param task - Does one run; it must not reject.
 * @returns Its `request` and `settled` functions.
 */
export function createCoalescingRunner(task: () => Promise<void>): CoalescingRunner {
	const state: CoalescingState = { isPending: false, running: undefined };

	return {
		request: () => {
			if (state.running === undefined) {
				state.running = loopAsync(state, task);
				return;
			}

			state.isPending = true;
		},
		settled: async () => {
			await state.running;
		},
	};
}

/**
 * Take the pending request, if any.
 *
 * @param state - The runner's state.
 * @returns Whether a request was pending.
 */
function takePending(state: CoalescingState): boolean {
	const { isPending } = state;
	state.isPending = false;
	return isPending;
}

async function loopAsync(state: CoalescingState, task: () => Promise<void>): Promise<void> {
	do {
		await task();
	} while (takePending(state));

	state.running = undefined;
}
