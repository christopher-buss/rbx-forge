import { log } from "@clack/prompts";

import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import process from "node:process";

import type { ResolvedConfig } from "../config/schema";
import { STUDIO_LOCKFILE_SUFFIX } from "../constants";

export interface WatchStudioLockFileOptions {
	/**
	 * Optional: called when watcher errors occur. If not provided, errors are
	 * logged with a default handler.
	 */
	onError?: (error: Error) => void;
	/** Called when Studio closes the file (lock file removed). */
	onStudioClose: () => Promise<void> | void;
	/** Optional: called when Studio opens the file (lock file created). */
	onStudioOpen?: () => Promise<void> | void;
}

/**
 * Helper to construct Studio lock file path from config.
 *
 * @param config - The resolved project configuration.
 * @returns Absolute path to the Studio lock file.
 */
export function getStudioLockFilePath(config: ResolvedConfig): string {
	const projectPath = process.cwd();
	return path.join(projectPath, config.buildOutputPath + STUDIO_LOCKFILE_SUFFIX);
}

/**
 * Watches for Studio lock file removal and calls callback when detected.
 * Handles cleanup, errors, and graceful shutdown automatically via
 * SIGINT/SIGTERM handlers.
 *
 * Returns a Promise that resolves when the Studio lock file is removed (Studio
 * closes).
 *
 * @example
 *
 * ```typescript
 * await watchStudioLockFile(getStudioLockFilePath(config), {
 * 	onStudioClose: () => {
 * 		log.info("Studio closed!");
 * 	},
 * });
 * // Execution continues here after Studio closes
 * ```
 *
 * @param studioLockFilePath - Absolute path to the Studio lock file.
 * @param options - Configuration options for watcher behavior.
 * @returns Promise that resolves when Studio closes the file.
 */
export async function watchStudioLockFile(
	studioLockFilePath: string,
	options: WatchStudioLockFileOptions,
): Promise<void> {
	return new Promise<void>((resolve) => {
		const watcher = chokidar.watch(studioLockFilePath, { ignoreInitial: true });
		const cleanup = createCleanupHandler(watcher);

		setupSignalHandlers(cleanup);
		setupWatcherEvents(watcher, options, cleanup, resolve);
	});
}

/**
 * Create a cleanup handler that closes the watcher and prevents duplicate
 * cleanup.
 *
 * @param watcher - The FSWatcher instance to clean up.
 * @returns The cleanup function.
 */
function createCleanupHandler(watcher: FSWatcher): () => Promise<void> {
	let isShuttingDown = false;

	return async () => {
		if (isShuttingDown) {
			return;
		}

		isShuttingDown = true;

		try {
			await watcher.close();
		} catch (err) {
			// Ignore errors during cleanup
			const message = err instanceof Error ? err.message : String(err);
			log.warn(`Error closing watcher: ${message}`);
		}
	};
}

/**
 * Handle watcher errors by logging them.
 *
 * @param error - The error that occurred.
 */
function handleWatcherError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	log.error(`Watcher error: ${message}`);
}

/**
 * Setup signal handlers for graceful shutdown on SIGINT/SIGTERM.
 *
 * @param cleanup - The cleanup function to call on signal.
 */
function setupSignalHandlers(cleanup: () => Promise<void>): void {
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			void (async () => {
				try {
					await cleanup();
				} finally {
					process.exit(0);
				}
			})();
		});
	}
}

/**
 * Setup watcher event handlers for add, unlink, and error events.
 *
 * @param watcher - The FSWatcher instance.
 * @param options - Configuration options for watcher behavior.
 * @param cleanup - The cleanup function.
 * @param resolve - Promise resolver for when Studio closes.
 */
function setupWatcherEvents(
	watcher: FSWatcher,
	{ onError, onStudioClose, onStudioOpen }: WatchStudioLockFileOptions,
	cleanup: () => Promise<void>,
	resolve: () => void,
): void {
	watcher.on("add", () => {
		if (onStudioOpen !== undefined) {
			void (async () => {
				await onStudioOpen();
			})();
		}
	});

	watcher.on("unlink", () => {
		void (async () => {
			await onStudioClose();
			await cleanup();
			resolve();
		})();
	});

	watcher.on("error", (error) => {
		if (onError !== undefined) {
			onError(error instanceof Error ? error : new Error(String(error)));
		} else {
			handleWatcherError(error);
		}
	});
}
