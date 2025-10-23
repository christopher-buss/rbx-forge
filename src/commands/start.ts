import { log, outro } from "@clack/prompts";

import ansis from "ansis";
import process from "node:process";
import { runScript } from "src/utils/run";

import { loadProjectConfig } from "../config";

export const COMMAND = "start";
export const DESCRIPTION = "Compile, build, and open in Roblox Studio with optional syncback";

export async function action(): Promise<void> {
	const config = await loadProjectConfig();

	log.info(ansis.bold("→ Starting full build workflow"));

	await runScript("compile");
	await runScript("build");

	const abortController = new AbortController();
	setupSignalHandlers(abortController);

	try {
		await runWorkflow(config, abortController);
		outro(ansis.green("✨ Start workflow complete, successfully exited!"));
	} catch (err) {
		if (!isCancellationError(err)) {
			throw err;
		}

		// Cancellation is expected when Studio closes or user presses Ctrl+C
		outro(ansis.green("✨ Start workflow complete, successfully exited!"));
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
			err.message.includes("abort"))
	);
}

/**
 * Run the open and syncback workflow concurrently.
 *
 * @param config - The project configuration.
 * @param abortController - AbortController to cancel syncback when open exits.
 */
async function runWorkflow(
	config: Awaited<ReturnType<typeof loadProjectConfig>>,
	abortController: AbortController,
): Promise<void> {
	await Promise.all([
		runScript("open").finally(() => {
			abortController.abort();
		}),
		config.syncback.runOnStart
			? runScript("syncback", ["--watch"], { cancelSignal: abortController.signal })
			: Promise.resolve(),
	]);
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
