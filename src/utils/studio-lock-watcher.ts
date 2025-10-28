import { log } from "@clack/prompts";

import chokidar, { type FSWatcher } from "chokidar";
import fs from "node:fs/promises";
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

interface SetupWatcherEventsOptions {
	cleanup: () => Promise<void>;
	options: WatchStudioLockFileOptions;
	reject: (err: Error) => void;
	resolve: () => void;
	watcher: FSWatcher;
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
	// Check if lock file already exists before starting watcher
	const isFileExisting = await checkFileExists(studioLockFilePath);
	if (isFileExisting && options.onStudioOpen !== undefined) {
		await options.onStudioOpen();
	}

	return new Promise<void>((resolve, reject) => {
		const watcher = chokidar.watch(studioLockFilePath, { ignoreInitial: true });
		const cleanup = createCleanupHandler(watcher);

		setupWatcherEvents({ cleanup, options, reject, resolve, watcher });
	});
}

/**
 * Check if a file exists.
 *
 * @param filePath - Path to check.
 * @returns True if file exists, false otherwise.
 */
async function checkFileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
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
 * Create shutdown handler for ProcessManager signals.
 *
 * @param cleanup - Cleanup function to call.
 * @param reject - Reject function for the promise.
 * @returns Shutdown handler function.
 */
function createShutdownHandler(
	cleanup: () => Promise<void>,
	reject: (err: Error) => void,
): () => void {
	return () => {
		void cleanup().finally(() => {
			reject(new Error("Shutdown"));
		});
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
 * Setup watcher event handlers for add, unlink, and error events.
 *
 * @param parameters - Configuration object for watcher events.
 */
function setupWatcherEvents(parameters: SetupWatcherEventsOptions): void {
	const { cleanup, options, reject, resolve, watcher } = parameters;
	const { onError, onStudioClose, onStudioOpen } = options;

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

	const shutdownHandler = createShutdownHandler(cleanup, reject);
	process.once("SIGTERM", shutdownHandler);
	process.once("SIGINT", shutdownHandler);
}
