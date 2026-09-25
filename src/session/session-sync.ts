import { ForgeError, toForgeError } from "../errors.ts";
import type { HookResult } from "../hooks/run-hooks.ts";
import type { SyncbackOutcome } from "../syncback/syncback.ts";

/** How one syncback run of the session ended. */
export type SyncbackAttempt =
	| { error: unknown; ok: false }
	| { hooks: Array<HookResult>; ok: true; value: SyncbackOutcome };

/**
 * `forge sync` inside a session: the control channel
 * asks, the session body runs. The channel opens before the body can run
 * syncback, so a request waits until the body hands its runner over.
 */
export interface SessionSync {
	/**
	 * The body can run syncback now, one run at a time with the save watch.
	 * Does nothing once closed.
	 */
	attach: (run: () => Promise<SyncbackAttempt>) => void;
	/**
	 * The session is ending: every request from now on, and every waiting one,
	 * fails.
	 */
	close: () => void;
	/**
	 * Run syncback with its hooks through the session.
	 *
	 * @returns What was synced and every hook result.
	 * @rejects {ForgeError} `not_running` once the session is stopping; else
	 *   the run's own failure, such as `hook_failed` with its hooks in
	 *   `details.hooks`.
	 */
	runAsync: () => Promise<Record<string, unknown>>;
}

/**
 * Make the link between a session's control channel and its body for
 * `forge sync`.
 *
 * @returns A link with no runner yet.
 */
export function createSessionSync(): SessionSync {
	const runner = Promise.withResolvers<(() => Promise<SyncbackAttempt>) | undefined>();
	let isClosed = false;
	return {
		attach: (run) => {
			runner.resolve(run);
		},
		close: () => {
			isClosed = true;
			runner.resolve(undefined);
		},
		runAsync: async () => {
			const run = await runner.promise;
			if (run === undefined || isClosed) {
				throw stopping();
			}

			const attempt = await run();
			if (!attempt.ok) {
				throw toForgeError(attempt.error);
			}

			return { ...attempt.value, hooks: attempt.hooks };
		},
	};
}

function stopping(): ForgeError {
	return new ForgeError("not_running", "The session is stopping; it runs no more syncback.", {
		hint: 'Start a session with "forge up", or run "forge syncback".',
	});
}
