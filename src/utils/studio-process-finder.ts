import { isWsl } from "./is-wsl";
import { runOutput } from "./run";
import { runPlatform } from "./run-platform";

/**
 * Finds the PID of a recently launched Roblox Studio process.
 *
 * This function searches for Studio processes and returns the PID of the most
 * recently started one. It polls for a short time to account for launch delay.
 *
 * @param timeoutMs - Maximum time to wait for Studio process (default: 5000ms).
 * @returns The PID of the Studio process, or null if not found.
 */
export async function findStudioProcess(timeoutMs = 5000): Promise<null | number> {
	const startTime = Date.now();
	const pollIntervalMs = 500;

	while (Date.now() - startTime < timeoutMs) {
		const pid = await tryFindStudioProcess();
		if (pid !== null) {
			return pid;
		}

		// Wait before next poll
		await new Promise((resolve) => {
			setTimeout(resolve, pollIntervalMs);
		});
	}

	return null;
}

/**
 * Gets Studio process on macOS.
 *
 * @param hideOutput - Output hiding options.
 * @returns Trimmed command output.
 */
async function getStudioProcessDarwin(hideOutput: {
	shouldShowCommand: boolean;
	shouldStreamOutput: boolean;
}): Promise<string> {
	// On macOS, Studio runs as "RobloxStudio"
	// cspell:ignore pgrep
	const result = await runOutput("pgrep", ["-f", "RobloxStudio"], hideOutput);
	return result.trim();
}

/**
 * Gets Studio process on Linux/WSL.
 *
 * @param hideOutput - Output hiding options.
 * @returns Trimmed command output.
 */
async function getStudioProcessLinux(hideOutput: {
	shouldShowCommand: boolean;
	shouldStreamOutput: boolean;
}): Promise<string> {
	if (isWsl()) {
		// In WSL, use tasklist.exe to find Windows processes
		// cspell:ignore IMAGENAME
		const result = await runOutput(
			"tasklist.exe",
			["/FI", "IMAGENAME eq RobloxStudioBeta.exe", "/FO", "CSV", "/NH"],
			hideOutput,
		);
		return result.trim();
	}

	// On native Linux, try to find Studio (though it may not be supported)
	// cspell:ignore pgrep
	const result = await runOutput("pgrep", ["-f", "RobloxStudio"], hideOutput);
	return result.trim();
}

/**
 * Gets Studio process on Windows.
 *
 * @param hideOutput - Output hiding options.
 * @returns Trimmed command output.
 */
async function getStudioProcessWin32(hideOutput: {
	shouldShowCommand: boolean;
	shouldStreamOutput: boolean;
}): Promise<string> {
	// On Windows, use tasklist to find Studio
	// cspell:ignore IMAGENAME
	const result = await runOutput(
		"tasklist",
		["/FI", "IMAGENAME eq RobloxStudioBeta.exe", "/FO", "CSV", "/NH"],
		hideOutput,
	);
	return result.trim();
}

/**
 * Parses PID from platform-specific process listing output.
 *
 * @param output - Raw output from process listing command.
 * @returns Parsed PID, or null if parsing failed.
 */
function parsePidFromOutput(output: string): null | number {
	if (!output) {
		return null;
	}

	// For pgrep (macOS/Linux): output is just the PID(s), one per line
	// For tasklist (Windows/WSL): CSV format: "ImageName","PID","SessionName",...
	const lines = output.split("\n").filter((line) => line.trim() !== "");

	if (lines.length === 0) {
		return null;
	}

	const firstLine = lines[0];
	if (firstLine === undefined) {
		return null;
	}

	// Check if it's CSV format (Windows tasklist)
	if (firstLine.includes(",")) {
		// CSV format: "RobloxStudioBeta.exe","12345","Console",...
		const match = firstLine.match(/"[^"]+","(\d+)"/);
		if (match?.[1] !== undefined) {
			const pid = Number.parseInt(match[1], 10);
			return Number.isNaN(pid) ? null : pid;
		}

		return null;
	}

	// Otherwise, it's pgrep output - just the PID
	// Get the first PID (most recent is usually first or we just take any)
	const pid = Number.parseInt(firstLine, 10);
	return Number.isNaN(pid) ? null : pid;
}

/**
 * Attempts to find a Roblox Studio process once.
 *
 * @returns The PID of a Studio process, or null if not found.
 */
async function tryFindStudioProcess(): Promise<null | number> {
	try {
		const hideOutput = { shouldShowCommand: false, shouldStreamOutput: false };

		const output = await runPlatform({
			darwin: async () => getStudioProcessDarwin(hideOutput),
			linux: async () => getStudioProcessLinux(hideOutput),
			win32: async () => getStudioProcessWin32(hideOutput),
		});

		return parsePidFromOutput(output);
	} catch {
		// Process not found or command failed
		return null;
	}
}
