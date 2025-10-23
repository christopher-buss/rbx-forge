import { log } from "@clack/prompts";

import ansis from "ansis";
import chokidar, { type FSWatcher } from "chokidar";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { loadProjectConfig } from "../config";
import { STUDIO_LOCKFILE_SUFFIX } from "../constants";
import { formatDuration } from "../utils/format-duration";
import { addPidToLockfile, removePidFromLockfile } from "../utils/lockfile";
import { getRojoCommand } from "../utils/rojo";
import { createSpinner, run, runOutput } from "../utils/run";

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

interface WatchState {
	hasLockfile: boolean;
	inputPath: string;
	isProcessing: boolean;
	lastModified: number;
	studioLockFile: string;
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
				await executeSyncback(rojo, state.inputPath, commandOptions);
			} finally {
				state.isProcessing = false;
			}
		})();
	};
}

/**
 * Create a handler for file unlink events to detect lock file removal.
 *
 * @param state - The watch state.
 * @param onLockfileRemoved - Callback to invoke when lock file is removed.
 * @returns A function that handles file unlink events.
 */
function createUnlinkHandler(
	state: WatchState,
	onLockfileRemoved: () => void,
): (filePath: string) => void {
	return (filePath: string) => {
		if (filePath !== state.studioLockFile || !state.hasLockfile) {
			return;
		}

		void (async () => {
			await waitForCompletion(state);

			// No syncback in progress, safe to exit
			log.info("\nStudio lock file removed - stopping syncback watch...");
			onLockfileRemoved();
		})();
	};
}

/**
 * Execute a syncback operation with progress reporting and spinner feedback.
 *
 * @param rojo - The rojo command to execute.
 * @param inputPath - Path to the input file to syncback from.
 * @param commandOptions - Options including verbosity and color settings.
 */
async function executeSyncback(
	rojo: string,
	inputPath: string,
	commandOptions: SyncbackOptions,
): Promise<void> {
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
 * @param studioLockFile - Path to the studio lock file.
 * @returns The initialized watch state.
 */
function initializeWatchState(inputPath: string, studioLockFile: string): WatchState {
	log.info(ansis.bold("→ Starting syncback watch mode"));
	log.step(`Watching: ${ansis.cyan(inputPath)}`);
	log.step(ansis.dim("Press Ctrl+C to stop"));

	return {
		hasLockfile: false,
		inputPath,
		isProcessing: false,
		lastModified: 0,
		studioLockFile,
		watcher: chokidar.watch([inputPath, studioLockFile], {
			ignoreInitial: true,
			persistent: true,
		}),
	};
}

/**
 * Setup signal handlers for graceful shutdown.
 *
 * @param shutdown - The shutdown function to call.
 */
function setupSignalHandlers(shutdown: () => Promise<void>): void {
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			void shutdown();
			process.exit(0);
		});
	}
}

/**
 * Setup watcher event handlers for lock file detection and changes.
 *
 * @param state - The watch state.
 * @param rojo - The rojo command.
 * @param commandOptions - Syncback command options.
 * @param onLockfileRemoved - Callback when lock file is removed.
 */
function setupWatcherEvents(
	state: WatchState,
	rojo: string,
	commandOptions: SyncbackOptions,
	onLockfileRemoved: () => void,
): void {
	state.watcher.on("add", (filePath) => {
		if (filePath !== state.studioLockFile) {
			return;
		}

		log.info("\nStudio lock file detected - monitoring for changes...");
		state.hasLockfile = true;
	});

	state.watcher.on("unlink", createUnlinkHandler(state, onLockfileRemoved));
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
	const config = await loadProjectConfig();
	const projectPath = process.cwd();
	const studioLockFile = path.join(projectPath, config.buildOutputPath + STUDIO_LOCKFILE_SUFFIX);

	const shouldTrackProcess = process.env["RBX_FORGE_CMD"] !== "start";
	if (shouldTrackProcess) {
		await addPidToLockfile(process.pid);
	}

	const state = initializeWatchState(inputPath, studioLockFile);

	async function shutdown(): Promise<void> {
		log.info("\nStopping syncback watch...");
		await state.watcher.close();
		await removePidFromLockfile(process.pid);
	}

	setupSignalHandlers(shutdown);

	await new Promise<void>((resolve) => {
		setupWatcherEvents(state, rojo, commandOptions, resolve);
	});

	await shutdown();
}
