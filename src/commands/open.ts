import { cancel, confirm, isCancel, log, outro } from "@clack/prompts";

import ansis from "ansis";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { ResolvedConfig } from "src/config/schema";

import { loadProjectConfig } from "../config";
import { CLI_COMMAND } from "../constants";
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
		description: "Build before opening",
		flags: "-b, --build",
	},
	{
		description: "Skip building before opening",
		flags: "-B, --no-build",
	},
	{
		description: "Path to the place file to open (overrides config)",
		flags: "-p, --place <path>",
	},
] as const;

export interface OpenOptions {
	build?: boolean;
	place?: string;
}

export async function action(commandOptions: OpenOptions = {}): Promise<void> {
	const config = await loadProjectConfig();
	const isDirectInvocation = process.env["RBX_FORGE_CMD"] === "open";
	const placeFile =
		commandOptions.place ??
		(isDirectInvocation ? config.open.buildOutputPath : undefined) ??
		config.buildOutputPath;
	const isCustomPlace = commandOptions.place !== undefined;

	const shouldBuild =
		commandOptions.build ?? (isDirectInvocation ? config.open.buildFirst : false);

	const isBuildExplicitlyDisabled = commandOptions.build === false;

	await (shouldBuild
		? runOpenBuild(config, placeFile)
		: ensurePlaceFileExists(placeFile, isCustomPlace, config, isBuildExplicitlyDisabled));

	await openInStudio(placeFile);

	if (config.rbxts.watchOnOpen && process.env["RBX_FORGE_CMD"] === "open") {
		await startWatchOnStudioClose(config);
	}
}

function getOpenBuildArgs(config: ResolvedConfig): Array<string> {
	const args: Array<string> = [];
	if (config.open.buildOutputPath !== undefined) {
		args.push("--output", config.open.buildOutputPath);
	}

	if (config.open.projectPath !== undefined) {
		args.push("--project", config.open.projectPath);
	}

	return args;
}

async function runOpenBuild(config: ResolvedConfig, placeFile: string): Promise<void> {
	if (config.projectType === "rbxts") {
		await runScript("compile");
	}

	const isDirectInvocation = process.env["RBX_FORGE_CMD"] === "open";
	const openArgs = isDirectInvocation ? getOpenBuildArgs(config) : [];

	// Ensure build outputs to the same file Studio will open
	if (!openArgs.includes("--output") && placeFile !== config.buildOutputPath) {
		openArgs.push("--output", placeFile);
	}

	// Bypass task runner when using open-specific args to avoid conflicting
	// with args baked into the user's build script
	if (openArgs.length > 0) {
		await run(CLI_COMMAND, ["build", ...openArgs], { shouldShowCommand: false });
		return;
	}

	await runScript("build");
}

async function openInStudio(placeFile: string): Promise<void> {
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
}

async function handleMissingPlaceFile(
	placeFile: string,
	isCustomPlace: boolean,
	config: ResolvedConfig,
	noBuild: boolean,
): Promise<void> {
	log.error(`Place file not found: ${ansis.cyan(placeFile)}`);

	// Don't offer to build custom place files or when --no-build was passed
	if (isCustomPlace || noBuild) {
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

	await runOpenBuild(config, placeFile);

	try {
		await access(placeFile);
	} catch {
		log.error("Build completed but place file was not created");
		process.exit(1);
	}
}

async function ensurePlaceFileExists(
	placeFile: string,
	isCustomPlace: boolean,
	config: ResolvedConfig,
	noBuild: boolean,
): Promise<void> {
	try {
		await access(placeFile);
	} catch {
		await handleMissingPlaceFile(placeFile, isCustomPlace, config, noBuild);
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
