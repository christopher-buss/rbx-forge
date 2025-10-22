import { log } from "@clack/prompts";

import ansis from "ansis";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { cleanupLockfile } from "src/utils/cleanup-lock-file";

import { loadProjectConfig } from "../config";
import { LOCKFILE_NAME, STUDIO_LOCKFILE_SUFFIX } from "../constants";
import { isWsl } from "../utils/is-wsl";
import { createSpinner, run } from "../utils/run";
import { runPlatform } from "../utils/run-platform";

export const COMMAND = "stop";
export const DESCRIPTION = "Stop running watch and Roblox Studio processes";

export async function action(): Promise<void> {
	const config = await loadProjectConfig();
	const projectPath = process.cwd();

	const watchLockFile = path.join(projectPath, LOCKFILE_NAME);
	const studioLockFile = path.join(projectPath, config.buildOutputPath + STUDIO_LOCKFILE_SUFFIX);

	const stoppedProcesses: Array<string> = [];
	const spinner = createSpinner("Stopping processes...");

	const didStopWatch = await tryStopProcess(watchLockFile);
	if (didStopWatch) {
		stoppedProcesses.push("watch");
	}

	const didStopStudio = await tryStopProcess(studioLockFile);
	if (didStopStudio) {
		stoppedProcesses.push("Roblox Studio");
	}

	if (stoppedProcesses.length === 0) {
		spinner.stop(ansis.dim("No running processes found"));
	} else {
		const processNames = stoppedProcesses.join(" and ");
		spinner.stop(ansis.green(`Stopped ${processNames}`));
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

async function tryStopProcess(lockFilePath: string): Promise<boolean> {
	try {
		const lockFileContents = await fs.readFile(lockFilePath, "utf-8");
		const processId = lockFileContents.split("\n")[0];

		if (processId === undefined || processId === "") {
			await cleanupLockfile(lockFilePath);
			return false;
		}

		try {
			await killProcess(processId);
			await cleanupLockfile(lockFilePath);
			return true;
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			log.warn(`Failed to kill process ${processId}: ${errorMessage}`);
			await cleanupLockfile(lockFilePath);
			return false;
		}
	} catch (err) {
		// Lockfile doesn't exist - this is expected if no process is running
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			return false;
		}

		const fileName = path.basename(lockFilePath);
		const errorMessage = err instanceof Error ? err.message : String(err);
		log.warn(`Failed to read lockfile ${fileName}: ${errorMessage}`);
		return false;
	}
}
