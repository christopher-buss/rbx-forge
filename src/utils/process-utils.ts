import { isWsl } from "./is-wsl";
import { run } from "./run";
import { runPlatform } from "./run-platform";

/**
 * Checks if a process with the given PID is still running.
 *
 * @param pid - Process ID to check.
 * @returns True if the process is running, false otherwise.
 */
export async function isProcessAlive(pid: number): Promise<boolean> {
	try {
		const hideOutput = { shouldShowCommand: false, shouldStreamOutput: false };

		await runPlatform({
			darwin: async () => run("ps", ["-p", String(pid)], hideOutput),
			linux: async () => {
				if (isWsl()) {
					// Use tasklist.exe in WSL
					return run("tasklist.exe", ["/FI", `PID eq ${pid}`], hideOutput);
				}

				return run("ps", ["-p", String(pid)], hideOutput);
			},
			win32: async () => run("tasklist", ["/FI", `PID eq ${pid}`], hideOutput),
		});

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
	const hideOutput = { shouldShowCommand: false, shouldStreamOutput: false };

	await runPlatform({
		darwin: async () => run("kill", ["-9", String(pid)], hideOutput),
		linux: async () => {
			if (isWsl()) {
				return run("taskkill.exe", ["/f", "/pid", String(pid)], hideOutput);
			}

			return run("kill", ["-9", String(pid)], hideOutput);
		},
		win32: async () => run("taskkill", ["/f", "/pid", String(pid)], hideOutput),
	});
}
