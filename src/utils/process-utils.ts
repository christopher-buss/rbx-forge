import { platform } from "node:process";

import { isWsl } from "./is-wsl";

/**
 * Checks if a process with the given PID is still running.
 *
 * @param pid - Process ID to check.
 * @returns True if the process is running, false otherwise.
 */
export async function isProcessAlive(pid: number): Promise<boolean> {
	try {
		if (platform === "win32") {
			await Bun.$`tasklist /FI "PID eq ${pid}"`.quiet();
		} else if (platform === "linux" && isWsl()) {
			await Bun.$`tasklist.exe /FI "PID eq ${pid}"`.quiet();
		} else {
			await Bun.$`ps -p ${pid}`.quiet();
		}

		return true;
	} catch {
		return false;
	}
}

/**
 * Kills a process with the given PID.
 *
 * @param pid - Process ID to kill.
 */
export async function killProcess(pid: number): Promise<void> {
	if (platform === "win32") {
		await Bun.$`taskkill /f /pid ${pid}`.quiet();
	} else if (platform === "linux" && isWsl()) {
		await Bun.$`taskkill.exe /f /pid ${pid}`.quiet();
	} else {
		await Bun.$`kill -9 ${pid}`.quiet();
	}
}
