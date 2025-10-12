import { cancel, confirm, isCancel, log } from "@clack/prompts";

import ansis from "ansis";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { loadProjectConfig } from "../config";
import type { ResolvedConfig } from "../config/schema";
import { getWindowsPath } from "../utils/get-windows-path";
import { isWsl } from "../utils/is-wsl";
import { run } from "../utils/run";
import { runPlatform } from "../utils/run-platform";
import { runScript } from "../utils/run-script";

export const COMMAND = "open";
export const DESCRIPTION = "Open place file in Roblox Studio";

export async function action(): Promise<void> {
	const config = await loadProjectConfig();
	const placeFile = config.buildOutputPath;

	await ensurePlaceFileExists(placeFile, config);

	log.info(ansis.bold("→ Opening in Roblox Studio"));
	log.step(`File: ${ansis.cyan(placeFile)}`);

	// Open with platform-specific command
	await runPlatform({
		darwin: async () => run("open", [placeFile], { shouldShowCommand: false }),
		linux: async () => {
			if (isWsl()) {
				const windowsPath = await getWindowsPath(path.resolve(placeFile));
				return run("powershell.exe", ["/c", `start ${windowsPath}`], {
					shouldShowCommand: false,
				});
			}

			// Native Linux: use xdg-open
			return run("xdg-open", [placeFile], { shouldShowCommand: false });
		},
		win32: async () => run("cmd.exe", ["/c", "start", placeFile], { shouldShowCommand: false }),
	});

	log.success("Opened in Roblox Studio");

	// Future: Implement watch functionality
	// if (config.rbxts.watchOnOpen) {
	// 	await runScript("serve", config);
	// }
}

async function ensurePlaceFileExists(placeFile: string, config: ResolvedConfig): Promise<void> {
	try {
		await access(placeFile);
	} catch {
		log.error(`Place file not found: ${ansis.cyan(placeFile)}`);

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

		// Run build command
		await runScript("build", config);

		// Verify file was created
		try {
			await access(placeFile);
		} catch {
			log.error("Build completed but place file was not created");
			process.exit(1);
		}
	}
}
