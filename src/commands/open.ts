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
import { run, runScript } from "../utils/run";
import { runPlatform } from "../utils/run-platform";
import { getStudioLockFilePath, watchStudioLockFile } from "../utils/studio-lock-watcher";

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
