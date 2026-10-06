/**
 * How long Studio gets to close its place on the close request when it
 * shows no dialog; forge then ends it, without a save. The longest window
 * of any OS.
 */
export const STUDIO_CLOSE_MS = 15_000;

/** The close window on macOS, where Studio often ignores `SIGTERM`. */
export const MAC_STUDIO_CLOSE_MS = 1000;

/**
 * The close window on an OS.
 *
 * @param platform - The OS.
 * @returns Milliseconds: {@link MAC_STUDIO_CLOSE_MS} on macOS, else
 *   {@link STUDIO_CLOSE_MS}.
 */
export function studioCloseMs(platform: NodeJS.Platform): number {
	return platform === "darwin" ? MAC_STUDIO_CLOSE_MS : STUDIO_CLOSE_MS;
}
