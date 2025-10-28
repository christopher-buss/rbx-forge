import { log } from "@clack/prompts";

import ansis from "ansis";
import fs from "node:fs/promises";
import path from "node:path";
import { getStudioLockFilePath } from "src/utils/studio-lock-watcher";

import { loadProjectConfig } from "../config";
import { isWsl } from "../utils/is-wsl";
import { cleanupLockfile } from "../utils/lockfile";
import { createSpinner, run } from "../utils/run";
import { runPlatform } from "../utils/run-platform";

export const COMMAND = "stop";
export const DESCRIPTION = "Stop running Roblox Studio processes";

export async function action(): Promise<void> {
	const config = await loadProjectConfig();

	const spinner = createSpinner("Stopping Roblox Studio...");

	const didStopStudio = await tryStopStudioProcess(getStudioLockFilePath(config));

	if (!didStopStudio) {
		spinner.stop(ansis.dim("No running Roblox Studio found"));
	} else {
		spinner.stop(ansis.green("Stopped Roblox Studio"));
	}
}

async function killProcess(processId: string): Promise<void> {
	const hideCommandOutput = { shouldShowCommand: false, shouldStreamOutput: false };

	await runPlatform({
		darwin: async () => run("kill", ["-9", processId], hideCommandOutput),
		linux: async () => {
			if (isWsl()) {
				return run("taskkill.exe", ["/f", "/pid", processId], hideCommandOutput);
			}

			return run("kill", ["-9", processId], hideCommandOutput);
		},
		win32: async () => run("taskkill", ["/f", "/pid", processId], hideCommandOutput),
	});
}

/**
 * Stops the Roblox Studio process using its lock file.
 *
 * @param lockFilePath - Path to the Studio lock file.
 * @returns True if Studio was stopped, false otherwise.
 */
async function tryStopStudioProcess(lockFilePath: string): Promise<boolean> {
	try {
		const lockFileContents = await fs.readFile(lockFilePath, "utf-8");
		const processId = lockFileContents.split("\n")[0];

		if (processId === undefined || processId === "") {
			await cleanupLockfile(lockFilePath);
			return false;
		}

		try {
			await killProcess(processId);
			return true;
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			log.warn(`Failed to kill Studio process ${processId}: ${errorMessage}`);
			return false;
		} finally {
			await cleanupLockfile(lockFilePath);
		}
	} catch (err) {
		// Lockfile doesn't exist - this is expected if Studio is not running
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			return false;
		}

		const fileName = path.basename(lockFilePath);
		const errorMessage = err instanceof Error ? err.message : String(err);
		log.warn(`Failed to read Studio lockfile ${fileName}: ${errorMessage}`);
		return false;
	}
}
