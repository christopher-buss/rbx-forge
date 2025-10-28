import { log, outro } from "@clack/prompts";

import ansis from "ansis";
import process from "node:process";
import {
	processManager,
	setupSignalHandlers as setupProcessManagerHandlers,
} from "src/utils/process-manager";
import { runScript } from "src/utils/run";
import { getStudioLockFilePath, watchStudioLockFile } from "src/utils/studio-lock-watcher";

import { loadProjectConfig } from "../config";
import { cleanupLockfile } from "../utils/lockfile";

export const COMMAND = "start";
export const DESCRIPTION = "Compile, build, and open in Roblox Studio with optional syncback";

export async function action(): Promise<void> {
	setupProcessManagerHandlers();

	const config = await loadProjectConfig();

	log.info(ansis.bold("→ Starting full build workflow"));

	await runScript("compile");
	await runScript("build");

	const abortController = new AbortController();
	setupSignalHandlers(abortController);

	try {
		await runWorkflow(config, abortController);

		// Workflow completed and cleanup already ran inside runWorkflow
		outro(ansis.green("✨ Start workflow complete, successfully exited!"));
		process.exit(0);
	} catch (err) {
		if (!isCancellationError(err) && !isShutdownError(err)) {
			throw err;
		}

		// Ctrl+C or expected shutdown - cleanup already ran in runWorkflow
		outro(ansis.green("✨ Start workflow complete, successfully exited!"));
		process.exit(0);
	} finally {
		cleanupSignalHandlers(abortController);
	}
}

/**
 * Remove SIGINT/SIGTERM signal handlers from process.
 *
 * @param abortController - AbortController used for signal handlers.
 */
function cleanupSignalHandlers(abortController: AbortController): void {
	const handler = createSignalHandler(abortController);
	process.off("SIGINT", handler);
	process.off("SIGTERM", handler);
}

/**
 * Create signal handler that aborts the controller.
 *
 * @param abortController - AbortController to abort on signal.
 * @returns Signal handler function.
 */
function createSignalHandler(abortController: AbortController): () => void {
	return () => {
		abortController.abort();
	};
}

/**
 * Cleanup handler for when Studio closes.
 *
 * @param config - Project configuration.
 * @param abortController - AbortController to abort running processes.
 */
async function handleStudioClose(
	config: Awaited<ReturnType<typeof loadProjectConfig>>,
	abortController: AbortController,
): Promise<void> {
	log.info("Studio closed - stopping workflow...");

	abortController.abort();

	await processManager.cleanup();

	// Clean up Studio lockfile
	await cleanupLockfile(getStudioLockFilePath(config));
}

/**
 * Check if error is from expected cancellation (abort signal).
 *
 * @param err - The error to check.
 * @returns True if error is from cancellation.
 */
function isCancellationError(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.name === "AbortError" ||
			err.message.includes("cancel") ||
			err.message.includes("abort") ||
			("signal" in err && err.signal === "SIGTERM") ||
			("signal" in err && err.signal === "SIGINT"))
	);
}

/**
 * Check if error is from shutdown signal.
 *
 * @param err - The error to check.
 * @returns True if error is from shutdown.
 */
function isShutdownError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("Shutdown");
}

/**
 * Run the full workflow: open Studio, watch for changes, and optionally run
 * syncback.
 *
 * Exits when either:
 *
 * - Studio closes (detected via lock file removal).
 * - User presses Ctrl+C (handled by ProcessManager).
 *
 * @param config - The project configuration.
 * @param abortController - AbortController to cancel syncback when Studio
 *   closes.
 */
async function runWorkflow(
	config: Awaited<ReturnType<typeof loadProjectConfig>>,
	abortController: AbortController,
): Promise<void> {
	startBackgroundProcesses(config, abortController);

	const studioWatcher = watchStudioLockFile(getStudioLockFilePath(config), {
		onStudioClose: async () => handleStudioClose(config, abortController),
	});

	try {
		await studioWatcher;
		await processManager.cleanup();
	} catch (err) {
		if (isShutdownError(err) || isCancellationError(err)) {
			return;
		}

		throw err;
	}
}

/**
 * Setup signal handlers for graceful shutdown on Ctrl+C.
 *
 * @param abortController - AbortController to trigger on signal.
 */
function setupSignalHandlers(abortController: AbortController): void {
	const handler = createSignalHandler(abortController);
	process.on("SIGINT", handler);
	process.on("SIGTERM", handler);
}

/**
 * Start background processes for the workflow.
 *
 * @param config - Project configuration.
 * @param abortController - AbortController for canceling processes.
 */
function startBackgroundProcesses(
	config: Awaited<ReturnType<typeof loadProjectConfig>>,
	abortController: AbortController,
): void {
	// Start child processes in background (will be killed when Studio closes)
	// Catch their rejections to prevent unhandled promise rejections

	runScript("open", [], { shouldRegisterProcess: true }).catch((err) => {
		if (!isCancellationError(err)) {
			log.warn(`Open script failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
	runScript("watch", [], { shouldRegisterProcess: true }).catch((err) => {
		if (!isCancellationError(err)) {
			log.warn(`Watch script failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	if (config.syncback.runOnStart) {
		runScript("syncback", ["--watch"], {
			cancelSignal: abortController.signal,
			shouldRegisterProcess: true,
		}).catch((err) => {
			if (!isCancellationError(err) && !isShutdownError(err)) {
				log.warn(
					`Syncback script failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		});
	}
}
