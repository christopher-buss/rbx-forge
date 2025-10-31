import { cancel, confirm, isCancel, log, outro } from "@clack/prompts";

import ansis from "ansis";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { ResolvedConfig } from "src/config/schema";

import { loadProjectConfig } from "../config";
import { getWindowsPath } from "../utils/get-windows-path";
import { isWsl } from "../utils/is-wsl";
import { cleanupLockfile } from "../utils/lockfile";
import { processManager, setupSignalHandlers } from "../utils/process-manager";
import { killProcess } from "../utils/process-utils";
import { run, runScript } from "../utils/run";
import { runPlatform } from "../utils/run-platform";
import { getStudioLockFilePath, watchStudioLockFile } from "../utils/studio-lock-watcher";
import { findStudioProcess } from "../utils/studio-process-finder";

export const COMMAND = "open";
export const DESCRIPTION = "Open place file in Roblox Studio";

export const options = [
	{
		description: "Path to the place file to open (overrides config)",
		flags: "-p, --place <path>",
	},
] as const;

export interface OpenOptions {
	place?: string;
}

interface InterruptSignalOptions {
	isLockFileCreated: boolean;
	reject: (err: Error) => void;
	resolve: () => void;
	studioLockFilePath: string;
	studioPid: number;
}

export async function action(commandOptions: OpenOptions = {}): Promise<void> {
	const config = await loadProjectConfig();
	const placeFile = commandOptions.place ?? config.buildOutputPath;
	const isCustomPlace = commandOptions.place !== undefined;

	await ensurePlaceFileExists(placeFile, isCustomPlace);

	log.info(ansis.bold("→ Opening in Roblox Studio"));
	log.step(`File: ${ansis.cyan(placeFile)}`);

	await runPlatform({
		darwin: async () => run("open", [placeFile], { shouldShowCommand: false }),
		linux: async () => {
			if (isWsl()) {
				const windowsPath = await getWindowsPath(path.resolve(placeFile));
				return run("powershell.exe", ["/c", `start ${windowsPath}`], {
					shouldShowCommand: false,
				});
			}

			return run("xdg-open", [placeFile], { shouldShowCommand: false });
		},
		win32: async () => run("cmd.exe", ["/c", "start", placeFile], { shouldShowCommand: false }),
	});

	log.success("Opened in Roblox Studio");

	// Track Studio PID and set up Ctrl+C handler
	// This will wait for Studio to create the lock file before returning
	await trackStudioProcess(config);

	if (config.rbxts.watchOnOpen && process.env["RBX_FORGE_CMD"] === "open") {
		await startWatchOnStudioClose(config);
	}
}

async function ensurePlaceFileExists(placeFile: string, isCustomPlace: boolean): Promise<void> {
	try {
		await access(placeFile);
	} catch {
		await handleMissingPlaceFile(placeFile, isCustomPlace);
	}
}

/**
 * Handles SIGINT signal during Studio launch.
 *
 * @param interruptOptions - Options for handling the interrupt signal.
 */
function handleInterruptSignal(interruptOptions: InterruptSignalOptions): void {
	const { isLockFileCreated, reject, resolve, studioLockFilePath, studioPid } = interruptOptions;

	// If lock file was created, Studio is running - just exit
	if (isLockFileCreated) {
		log.info("Studio has opened the place, leaving it running");
		resolve();
		return;
	}

	// Lock file not created - kill Studio and exit
	log.info("Studio hasn't opened the place yet, killing process...");
	killProcess(studioPid)
		.then(async () => {
			await cleanupLockfile(studioLockFilePath);
			resolve();
		})
		.catch((err) => {
			const errorMessage = err instanceof Error ? err.message : String(err);
			log.warn(`Failed to kill Studio process: ${errorMessage}`);
			reject(err instanceof Error ? err : new Error(String(err)));
		});
}

async function handleMissingPlaceFile(placeFile: string, isCustomPlace: boolean): Promise<void> {
	log.error(`Place file not found: ${ansis.cyan(placeFile)}`);

	// Don't offer to build custom place files
	if (isCustomPlace) {
		process.exit(1);
	}

	const shouldBuild = await confirm({
		initialValue: true,
		message: "Would you like to build the place file now?",
	});

	if (isCancel(shouldBuild)) {
		cancel("Operation cancelled");
		process.exit(0);
	}

	if (!shouldBuild) {
		process.exit(1);
	}

	await runScript("build");

	try {
		await access(placeFile);
	} catch {
		log.error("Build completed but place file was not created");
		process.exit(1);
	}
}

async function startWatchOnStudioClose(config: ResolvedConfig): Promise<void> {
	setupSignalHandlers();

	const studioLockFilePath = getStudioLockFilePath(config);
	const abortController = new AbortController();

	try {
		await Promise.race([
			runScript("watch", [], {
				cancelSignal: abortController.signal,
				shouldRegisterProcess: true,
			}),
			watchStudioLockFile(studioLockFilePath, {
				onStudioClose: async () => {
					if (process.env["RBX_FORGE_CMD"] === "open") {
						outro(ansis.green("Roblox Studio closed, stopping watch mode"));
					} else {
						log.info("Roblox Studio closed, stopping watch mode");
					}

					await processManager.cleanup();
					await cleanupLockfile(studioLockFilePath);
					abortController.abort();
				},
			}),
		]);
	} finally {
		// Cleanup complete
	}
}

/**
 * Tracks the Studio process and sets up Ctrl+C handler.
 *
 * If Ctrl+C is pressed before the lock file exists (Studio hasn't fully opened
 * the place), the Studio process will be killed.
 *
 * This waits for Studio to create the .lock file and writes the PID to it for
 * the stop command to use. If Ctrl+C is pressed before the lock file is
 * created, Studio will be killed.
 *
 * @param config - The resolved project configuration.
 */
async function trackStudioProcess(config: ResolvedConfig): Promise<void> {
	const studioLockFilePath = getStudioLockFilePath(config);

	// Find the Studio process PID
	const studioPidOrNull = await findStudioProcess();
	if (studioPidOrNull === null) {
		log.warn("Could not find Studio process, cleanup on Ctrl+C may not work");
		return;
	}

	// TypeScript type narrowing: studioPid is guaranteed to be number here
	const studioPid: number = studioPidOrNull;

	// Wait for Studio to create the lock file or for Ctrl+C
	await waitForStudioLockOrInterrupt(studioLockFilePath, studioPid);
}

/**
 * Waits for Studio to create the lock file or for user interrupt.
 *
 * @param studioLockFilePath - Path to the Studio lock file.
 * @param studioPid - Studio process PID.
 */
async function waitForStudioLockOrInterrupt(
	studioLockFilePath: string,
	studioPid: number,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let isLockFileCreated = false;

		/** Set up Ctrl+C handler. */
		function sigintHandler(): void {
			handleInterruptSignal({
				isLockFileCreated,
				reject,
				resolve,
				studioLockFilePath,
				studioPid,
			});
		}

		process.once("SIGINT", sigintHandler);

		// Watch for Studio to create the lock file
		void watchStudioLockFile(studioLockFilePath, {
			onStudioClose: () => {
				// Studio closed before fully opening - not expected but handle
				// gracefully
				process.removeListener("SIGINT", sigintHandler);
				resolve();
			},
			onStudioOpen: async () => {
				// Studio created the lock file - write PID to it for stop command
				await writeStudioLockFile(studioLockFilePath, studioPid);
				isLockFileCreated = true;
				// Remove the Ctrl+C handler since Studio is now running
				process.removeListener("SIGINT", sigintHandler);
				// Resolve to let the command complete
				resolve();
			},
		}).catch((err) => {
			// Watcher error
			process.removeListener("SIGINT", sigintHandler);
			reject(err instanceof Error ? err : new Error(String(err)));
		});
	});
}

/**
 * Writes Studio process PID to the lock file.
 *
 * Called when Studio creates the .lock file (when it opens the place). This
 * allows the stop command to read the PID later.
 *
 * @param lockFilePath - Path to the lock file.
 * @param pid - Studio process PID.
 */
async function writeStudioLockFile(lockFilePath: string, pid: number): Promise<void> {
	try {
		const fs = await import("node:fs/promises");
		await fs.writeFile(lockFilePath, `${pid}\n`, "utf-8");
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		log.warn(`Failed to write Studio lock file: ${errorMessage}`);
	}
}
