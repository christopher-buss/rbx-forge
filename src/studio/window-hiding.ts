import type { PinnedProcess } from "../native/addon.ts";
import type { Clock } from "../seams/clock.ts";

/** How often a watcher, or a wait for one, reads Studio's visibility. */
export const KEEP_HIDDEN_POLL_MS = 10;

/** How long a session waits for its watcher to hide windows. */
export const KEEP_HIDDEN_START_BOUND_MS = 10_000;

/**
 * Wait until the detached Windows watcher hides Studio's windows, so a window
 * Studio opens after it reads as open is never shown.
 *
 * @param pinned - The launched Studio.
 * @param clock - The polling clock.
 * @param signal - Ends the wait.
 * @returns `false` when {@link KEEP_HIDDEN_START_BOUND_MS} passes first.
 */
export async function waitForWindowHidingAsync(
	pinned: PinnedProcess,
	clock: Clock,
	signal: AbortSignal,
): Promise<boolean> {
	const deadline = clock.now() + KEEP_HIDDEN_START_BOUND_MS;
	while (!signal.aborted && pinned.isAlive() && !pinned.windowHiding()) {
		if (clock.now() >= deadline) {
			return false;
		}

		await clock.sleep(KEEP_HIDDEN_POLL_MS);
	}

	return true;
}
