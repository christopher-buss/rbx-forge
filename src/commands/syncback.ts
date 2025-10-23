import { log } from "@clack/prompts";

import ansis from "ansis";
import chokidar, { type FSWatcher } from "chokidar";
import { access } from "node:fs/promises";
import process from "node:process";

import { loadProjectConfig } from "../config";
import { formatDuration } from "../utils/format-duration";
import { addPidToLockfile, removePidFromLockfile } from "../utils/lockfile";
import { getRojoCommand } from "../utils/rojo";
import { createSpinner, run, runOutput } from "../utils/run";
import { getStudioLockFilePath, watchStudioLockFile } from "../utils/studio-lock-watcher";

export const COMMAND = "syncback";
export const DESCRIPTION = "Syncback changes from a place file to the project";

export const options = [
	{
		description: "Input place or model file to syncback from (overrides config)",
		flags: "-i, --input <path>",
	},
	{
		description: "Path to the project to syncback to (defaults to current directory)",
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
	project?: string;
	verbose?: boolean;
	watch?: boolean;
}

interface WatcherEventOptions {
	commandOptions: SyncbackOptions;
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
	const rojo = getRojoCommand();

	await checkRojoSyncback();

	const inputPath = commandOptions.input ?? config.syncbackInputPath;

	try {
		await access(inputPath);
	} catch {
		log.error(`Input file not found: ${ansis.cyan(inputPath)}`);
		process.exit(1);
	}

	await (commandOptions.watch === true
		? watchMode(rojo, inputPath, commandOptions)
		: singleMode(rojo, inputPath, commandOptions));
}

function buildRojoArguments(inputPath: string, syncbackOptions: SyncbackOptions): Array<string> {
	const args = ["syncback", "--input", inputPath, "--non-interactive"];

	if (syncbackOptions.project !== undefined && syncbackOptions.project.length > 0) {
		args.push(syncbackOptions.project);
	}

	if (syncbackOptions.verbose !== undefined && syncbackOptions.verbose) {
		args.push("--verbose");
	}

	if (syncbackOptions.color !== undefined && syncbackOptions.color.length > 0) {
		args.push("--color", syncbackOptions.color);
	}

	return args;
}

async function checkRojoSyncback(): Promise<void> {
	const rojo = getRojoCommand();

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
 * @param state - The watch state.
 * @param rojo - The rojo command to execute.
 * @param commandOptions - Syncback command options.
 * @returns A function that handles file change events.
 */
function createChangeHandler(
	state: WatchState,
	rojo: string,
	commandOptions: SyncbackOptions,
): (filePath: string) => void {
	return (filePath: string) => {
		// Only syncback when the input file changes, not the lock file
		if (filePath !== state.inputPath) {
			return;
		}

		void (async () => {
			// Prevent concurrent syncback operations
			if (state.isProcessing) {
				return;
			}

			// Get file modification time
			const now = Date.now();
			if (now - state.lastModified < 1000) {
				// Debounce: ignore if changed less than 1 second ago
				return;
			}

			state.lastModified = now;
			state.isProcessing = true;

			try {
				await executeSyncback(rojo, state.inputPath, commandOptions, state);
			} finally {
				state.isProcessing = false;
			}
		})();
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
		await removePidFromLockfile(process.pid);
	};
}

/**
 * Execute a syncback operation with progress reporting and spinner feedback.
 *
 * @param rojo - The rojo command to execute.
 * @param inputPath - Path to the input file to syncback from.
 * @param commandOptions - Options including verbosity and color settings.
 * @param state - Optional watch state to manage monitoring spinner.
 */
async function executeSyncback(
	rojo: string,
	inputPath: string,
	commandOptions: SyncbackOptions,
	state?: WatchState,
): Promise<void> {
	// Stop the monitoring spinner if in watch mode
	state?.monitoringSpinner?.stop();

	log.info(`\n${ansis.dim(new Date().toLocaleTimeString())} - ${inputPath} changed`);

	const startTime = performance.now();
	const spinner = createSpinner("Running syncback...");

	const rojoArgs = buildRojoArguments(inputPath, commandOptions);

	try {
		await run(rojo, rojoArgs, {
			shouldStreamOutput: commandOptions.verbose !== undefined,
		});

		const duration = formatDuration(startTime);
		spinner.stop(`Syncback succeeded (${ansis.dim(duration)})`);
	} catch {
		spinner.stop(ansis.red("Syncback failed"));
	}

	// Restart the monitoring spinner if in watch mode
	if (state !== undefined) {
		state.monitoringSpinner = createSpinner("Monitoring for changes...");
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
	const { commandOptions, rojo, state } = watcherOptions;

	state.watcher.on("change", createChangeHandler(state, rojo, commandOptions));
	state.watcher.on("error", handleWatcherError);
}

async function singleMode(
	rojo: string,
	inputPath: string,
	commandOptions: SyncbackOptions,
): Promise<void> {
	log.info(ansis.bold("→ Running syncback"));
	log.step(`Input: ${ansis.cyan(inputPath)}`);

	const startTime = performance.now();
	const spinner = createSpinner("Syncing back changes...");

	const rojoArgs = buildRojoArguments(inputPath, commandOptions);

	try {
		await run(rojo, rojoArgs, {
			shouldStreamOutput: commandOptions.verbose !== undefined,
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

async function watchMode(
	rojo: string,
	inputPath: string,
	commandOptions: SyncbackOptions,
): Promise<void> {
	const shouldTrackProcess = process.env["RBX_FORGE_CMD"] !== "start";
	if (shouldTrackProcess) {
		await addPidToLockfile(process.pid);
	}

	logWatchModeStart(inputPath);

	const config = await loadProjectConfig();
	const state = await initializeWatchState(inputPath);
	const waitingSpinner = createSpinner("Waiting for Studio lock file...");
	const shutdown = createShutdownHandler(state, waitingSpinner);

	setupWatcherEvents({ commandOptions, rojo, state });

	await watchStudioLockFile(getStudioLockFilePath(config), {
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
