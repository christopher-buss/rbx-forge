import type { StudioEnd } from "./close-studio.ts";

/**
 * How long Studio gets to close its place on the close request when it
 * shows no dialog; forge then ends it, without a save. The longest time
 * limit of any OS.
 */
export const STUDIO_CLOSE_MS = 15_000;

/** The close time limit on macOS, where Studio often ignores `SIGTERM`. */
export const MAC_STUDIO_CLOSE_MS = 1000;

/**
 * The close time limit on an OS.
 *
 * @param platform - The OS.
 * @returns Milliseconds: {@link MAC_STUDIO_CLOSE_MS} on macOS, else
 *   {@link STUDIO_CLOSE_MS}.
 */
export function studioCloseMs(platform: NodeJS.Platform): number {
	return platform === "darwin" ? MAC_STUDIO_CLOSE_MS : STUDIO_CLOSE_MS;
}

/**
 * Why forge ended Studio, as a summary clause.
 *
 * @param end - A forced end: `dialog`, `no_window`, or `timeout`.
 * @param platform - The OS, for its close time limit.
 * @returns Text such as `a dialog blocked it`.
 */
export function forcedEndClause(
	end: Exclude<StudioEnd, "exited" | "lock_released">,
	platform: NodeJS.Platform,
): string {
	switch (end) {
		case "dialog": {
			return "a dialog blocked it";
		}
		case "no_window": {
			return "it had no window to close";
		}
		case "timeout": {
			return `it did not close within ${studioCloseMs(platform) / 1000} s`;
		}
	}
}
