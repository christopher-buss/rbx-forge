import ansis from "ansis";
import { getStudioLockFilePath } from "src/utils/studio-lock-watcher";
import yoctoSpinner from "yocto-spinner";

import { loadProjectConfig } from "../config";
import { cleanupLockfile, readLockfileRaw } from "../utils/lockfile";
import { logger } from "../utils/logger";
import { killProcess } from "../utils/process-utils";

export const COMMAND = "stop";
export const DESCRIPTION = "Stop running Roblox Studio processes";

export async function action(): Promise<void> {
	const config = await loadProjectConfig();

	const spinner = yoctoSpinner({ text: "Stopping Roblox Studio..." }).start();

	const didStopStudio = await tryStopStudioProcess(getStudioLockFilePath(config));

	if (!didStopStudio) {
		spinner.success(ansis.dim("No running Roblox Studio found"));
	} else {
		spinner.success(ansis.green("Stopped Roblox Studio"));
	}
}

/**
 * Stops the Roblox Studio process using its lock file.
 *
 * @param lockFilePath - Path to the Studio lock file.
 * @returns True if Studio was stopped, false otherwise.
 */
async function tryStopStudioProcess(lockFilePath: string): Promise<boolean> {
	const lines = await readLockfileRaw(lockFilePath);

	if (lines === null) {
		return false;
	}

	const processIdStr = lines[0];

	if (processIdStr === undefined || processIdStr === "") {
		await cleanupLockfile(lockFilePath);
		return false;
	}

	const processId = Number.parseInt(processIdStr, 10);
	if (Number.isNaN(processId)) {
		await cleanupLockfile(lockFilePath);
		return false;
	}

	try {
		await killProcess(processId);
		return true;
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		logger.warn(`Failed to kill Studio process ${processId}: ${errorMessage}`);
		return false;
	} finally {
		await cleanupLockfile(lockFilePath);
	}
}
