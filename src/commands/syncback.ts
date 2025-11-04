import { log } from "@clack/prompts";

import ansis from "ansis";
import chokidar, { type FSWatcher } from "chokidar";
import { access } from "node:fs/promises";
import process from "node:process";
import type { ResolvedConfig } from "src/config/schema";

import { loadProjectConfig } from "../config";
import { formatDuration } from "../utils/format-duration";
import { isGracefulShutdown } from "../utils/graceful-shutdown";
import { setupSignalHandlers } from "../utils/process-manager";
import { getRojoCommand } from "../utils/rojo";
import { createSpinner, run, runOutput, runScript } from "../utils/run";
import { getStudioLockFilePath, watchStudioLockFile } from "../utils/studio-lock-watcher";

/**
 * Debounce delay in milliseconds to prevent rapid successive syncback
 * operations.
 */
const DEBOUNCE_DELAY_MS = 1000;

export const COMMAND = "syncback";
export const DESCRIPTION = "Syncback changes from a place file to the project";

export const options = [
	{
		description: "Input place or model file to syncback from (overrides config)",
		flags: "-i, --input <path>",
	},
	{
		description: "Internal mode for per-execution hooks (not for direct use)",
		flags: "--internal",
		hidden: true,
	},
	{
		description: "Path to the project to syncback to",
		flags: "--project <path>",
	},
	{
		description: "Watch for changes and syncback automatically",
		flags: "-w, --watch",
	},
	{
		description: "Sets verbosity level. Can be specified multiple times",
		flags: "-v, --verbose",
	},
	{
		description: "Set color behavior (auto, always, or never)",
		flags: "--color <mode>",
	},
] as const;

export interface SyncbackOptions {
	color?: string;
	input?: string;
	internal?: boolean;
	project?: string;
	verbose?: boolean;
	watch?: boolean;
}

interface SyncbackContext {
	commandOptions: SyncbackOptions;
	config: Awaited<ReturnType<typeof loadProjectConfig>>;
	inputPath: string;
	rojo: string;
}

interface WatcherEventOptions {
	commandOptions: SyncbackOptions;
	config: Awaited<ReturnType<typeof loadProjectConfig>>;
	rojo: string;
	state: WatchState;
}

interface WatchState {
	inputPath: string;
	isProcessing: boolean;
	lastModified: number;
	monitoringSpinner?: ReturnType<typeof createSpinner>;
	watcher: FSWatcher;
}

export async function action(commandOptions: SyncbackOptions = {}): Promise<void> {
	const config = await loadProjectConfig();
	const rojo = getRojoCommand(config);

	await checkRojoSyncback(config);

	const inputPath = commandOptions.input ?? config.syncbackInputPath;

	try {
		await access(inputPath);
	} catch {
		log.error(`Input file not found: ${ansis.cyan(inputPath)}`);
		process.exit(1);
	}

	const context: SyncbackContext = {
		commandOptions,
		config,
		inputPath,
		rojo,
	};

	// Internal mode for per-execution hooks (minimal execution, no signal
	// handlers)
	if (commandOptions.internal === true) {
		await internalMode(context);
		return;
	}

	// Setup signal handlers for watch and single modes
	setupSignalHandlers();

	await (commandOptions.watch === true ? watchMode(context) : singleMode(context));
}

/**
 * Build CLI arguments for internal mode syncback execution.
 *
 * @param context - Syncback context containing configuration and options.
 * @returns Array of CLI arguments for the syncback command.
 */
function buildInternalModeArgs(context: SyncbackContext): Array<string> {
	const args = ["--internal", "--input", context.inputPath];

	if (context.commandOptions.project !== undefined && context.commandOptions.project.length > 0) {
		args.push("--project", context.commandOptions.project);
	}

	if (context.commandOptions.verbose !== undefined && context.commandOptions.verbose) {
		args.push("--verbose");
	}

	if (context.commandOptions.color !== undefined && context.commandOptions.color.length > 0) {
		args.push("--color", context.commandOptions.color);
	}

	return args;
}

function buildRojoArguments(
	inputPath: string,
	syncbackOptions: SyncbackOptions,
	config: ResolvedConfig,
): Array<string> {
	const args = ["syncback", "--input", inputPath, "--non-interactive"];

	const projectPath =
		syncbackOptions.project ?? config.syncback.projectPath ?? config.rojoProjectPath;
	if (projectPath.length > 0) {
		args.push(projectPath);
	}

	if (syncbackOptions.verbose !== undefined && syncbackOptions.verbose) {
		args.push("--verbose");
	}

	if (syncbackOptions.color !== undefined && syncbackOptions.color.length > 0) {
		args.push("--color", syncbackOptions.color);
	}

	return args;
}

async function checkRojoSyncback(config: ResolvedConfig): Promise<void> {
	const rojo = getRojoCommand(config);

	try {
		await runOutput(rojo, ["syncback", "--help"]);
	} catch (err) {
		let message = "Rojo syncback functionality is not available.\n\n";
		message += "Syncback requires the UpliftGames fork of Rojo with syncback support.\n\n";
		message += "Installation options:\n";
		message += "• Download from: https://github.com/UpliftGames/rojo/releases/\n";
		message += "Note: Standard Rojo does not currently include syncback functionality.";

		if (err !== undefined) {
			const errorDetails = err instanceof Error ? err.message : String(err);
			message += ansis.dim(`\n\nError details:\n${errorDetails}`);
		}

		throw new Error(message);
	}
}

/**
 * Create a handler for file change events with debouncing and syncback
 * execution.
 *
 * @param context - Syncback context containing configuration and options.
 * @param state - The watch state.
 * @returns A function that handles file change events.
 */
function createChangeHandler(
	context: SyncbackContext,
	state: WatchState,
): (filePath: string) => void {
	return (filePath: string) => {
		// Only syncback when the input file changes, not the lock file
		if (filePath !== state.inputPath) {
			return;
		}

		void handleFileChange(context, state);
	};
}

/**
 * Create shutdown handler that stops the spinner and cleans up resources.
 *
 * @param state - The watch state.
 * @param spinner - Optional spinner to stop.
 * @returns The shutdown function.
 */
function createShutdownHandler(
	state: WatchState,
	spinner?: ReturnType<typeof createSpinner>,
): () => Promise<void> {
	return async () => {
		if (spinner !== undefined) {
			spinner.stop();
		}

		state.monitoringSpinner?.stop();
		log.info("\nStopping syncback watch...");
		await state.watcher.close();
	};
}

/**
 * Execute a syncback operation with progress reporting and spinner feedback.
 * Uses runScript() to enable user hooks via task runner scripts.
 *
 * @param context - Syncback context containing configuration and options.
 * @param state - Optional watch state to manage monitoring spinner.
 */
async function executeSyncback(context: SyncbackContext, state?: WatchState): Promise<void> {
	// Stop the monitoring spinner if in watch mode
	state?.monitoringSpinner?.stop();

	log.info(`\n${ansis.dim(new Date().toLocaleTimeString())} - ${context.inputPath} changed`);

	const startTime = performance.now();
	const spinner = createSpinner("Running syncback...");
	const args = buildInternalModeArgs(context);

	try {
		// Call via runScript to enable user hooks (forge:syncback script)
		await runScript("syncback", args, {
			shouldStreamOutput: context.commandOptions.verbose !== undefined,
		});

		const duration = formatDuration(startTime);
		spinner.stop(`Syncback succeeded (${ansis.dim(duration)})`);
	} catch (err) {
		if (isGracefulShutdown(err)) {
			spinner.stop("Syncback interrupted");
			throw err;
		}

		spinner.stop(ansis.red("Syncback failed"));
		throw err;
	}

	// Restart the monitoring spinner if in watch mode
	if (state !== undefined) {
		state.monitoringSpinner = createSpinner("Monitoring for changes...");
	}
}

/**
 * Handle file change with debouncing and execute syncback.
 *
 * @param context - Syncback context containing configuration and options.
 * @param state - The watch state.
 */
async function handleFileChange(context: SyncbackContext, state: WatchState): Promise<void> {
	// Prevent concurrent syncback operations
	if (state.isProcessing) {
		return;
	}

	// Get file modification time
	const now = Date.now();
	if (now - state.lastModified < DEBOUNCE_DELAY_MS) {
		// Debounce: ignore if changed less than 1 second ago
		return;
	}

	state.lastModified = now;
	state.isProcessing = true;

	try {
		await executeSyncback(context, state);
	} catch (err) {
		// Don't log errors for graceful shutdown (Ctrl+C)
		if (!isGracefulShutdown(err)) {
			const message = err instanceof Error ? err.message : String(err);
			log.error(`Syncback error: ${message}`);
		}
	} finally {
		state.isProcessing = false;
	}
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
 * Initialize watch state and display startup messages.
 *
 * @param inputPath - Path to the input file.
 * @returns The initialized watch state.
 */
async function initializeWatchState(inputPath: string): Promise<WatchState> {
	return {
		inputPath,
		isProcessing: false,
		lastModified: 0,
		watcher: chokidar.watch(inputPath),
	};
}

/**
 * Internal mode for per-execution hooks. Minimal execution without intro/outro
 * messages. Used by watch mode to enable user hooks via runScript().
 *
 * @param context - Syncback context containing configuration and options.
 */
async function internalMode(context: SyncbackContext): Promise<void> {
	const rojoArgs = buildRojoArguments(context.inputPath, context.commandOptions, context.config);

	await run(context.rojo, rojoArgs, {
		shouldShowCommand: false,
		shouldStreamOutput: context.commandOptions.verbose !== undefined,
	});
}

/**
 * Log watch mode startup messages.
 *
 * @param inputPath - The path being watched.
 */
function logWatchModeStart(inputPath: string): void {
	log.info(ansis.bold("→ Starting syncback watch mode"));
	log.step(`Watching: ${ansis.cyan(inputPath)}`);
	log.step(ansis.dim("Press Ctrl+C to stop"));
}

/**
 * Setup watcher event handlers for input file changes.
 *
 * @param watcherOptions - Configuration options for watcher events.
 */
function setupWatcherEvents(watcherOptions: WatcherEventOptions): void {
	const { commandOptions, config, rojo, state } = watcherOptions;

	const context: SyncbackContext = {
		commandOptions,
		config,
		inputPath: state.inputPath,
		rojo,
	};

	state.watcher.on("change", createChangeHandler(context, state));
	state.watcher.on("error", handleWatcherError);
}

async function singleMode(context: SyncbackContext): Promise<void> {
	log.info(ansis.bold("→ Running syncback"));
	log.step(`Input: ${ansis.cyan(context.inputPath)}`);

	const startTime = performance.now();
	const spinner = createSpinner("Syncing back changes...");

	const rojoArgs = buildRojoArguments(context.inputPath, context.commandOptions, context.config);

	try {
		await run(context.rojo, rojoArgs, {
			shouldStreamOutput: context.commandOptions.verbose !== undefined,
		});

		const duration = formatDuration(startTime);
		spinner.stop(`Syncback complete (${ansis.dim(duration)})`);
	} catch (err) {
		spinner.stop(ansis.red("Syncback failed"));
		throw err;
	}
}

/**
 * Wait for any in-progress syncback to complete before exiting.
 *
 * @param state - The watch state containing the processing flag.
 */
async function waitForCompletion(state: WatchState): Promise<void> {
	while (state.isProcessing) {
		await new Promise((resolve) => {
			setTimeout(resolve, 100);
		});
	}
}

async function watchMode(context: SyncbackContext): Promise<void> {
	logWatchModeStart(context.inputPath);

	const state = await initializeWatchState(context.inputPath);
	const waitingSpinner = createSpinner("Waiting for Studio lock file...");
	const shutdown = createShutdownHandler(state, waitingSpinner);

	setupWatcherEvents({
		commandOptions: context.commandOptions,
		config: context.config,
		rojo: context.rojo,
		state,
	});

	await watchStudioLockFile(getStudioLockFilePath(context.config), {
		onStudioClose: async () => {
			await waitForCompletion(state);
			state.monitoringSpinner?.stop("Studio lock file removed - stopping syncback watch...");
		},
		onStudioOpen: () => {
			waitingSpinner.stop("Studio lock file found!");
			state.monitoringSpinner = createSpinner("Monitoring for changes...");
		},
	});

	await shutdown();
}
