import os from "node:os";

/**
 * Execute platform-specific callbacks.
 *
 * @example
 *
 * ```ts
 * await runPlatform({
 * 	darwin: async () => run("open", ["file.txt"]),
 * 	win32: async () => run("start", ["file.txt"]),
 * 	linux: async () => run("xdg-open", ["file.txt"]),
 * });
 * ```
 *
 * @template R - The return type of the callback functions.
 * @param callbacks - Platform-specific callback functions.
 * @returns The result of the platform-specific callback.
 * @throws If no callback is provided for the current platform.
 */
export function runPlatform<R>(callbacks: Partial<Record<NodeJS.Platform, () => R>>): R {
	const callback = callbacks[os.platform()];
	if (callback) {
		return callback();
	}

	throw new Error(`Platform ${os.platform()} not supported`);
}
