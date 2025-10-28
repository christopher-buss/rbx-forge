/* cspell:words pgrep */
import { execa } from "execa";
import process from "node:process";

/**
 * Kills a process and all its descendants (children, grandchildren, etc.).
 *
 * Platform-specific implementation:
 *
 * - Windows: Uses `taskkill /pid PID /T /F` to kill the process tree
 * - MacOS: Uses `pgrep -P PID` to recursively find children (pgrep: process
 *   grep).
 * - Linux: Uses `ps -o pid --no-headers --ppid PID` to recursively find children.
 *
 * @param pid - The process ID to kill along with all descendants.
 * @param signal - The signal to send (default: SIGTERM). Ignored on Windows.
 */
export async function killProcessTree(pid: number | undefined, signal = "SIGTERM"): Promise<void> {
	if (pid === undefined) {
		throw new Error("Cannot kill process tree: PID is undefined");
	}

	await (process.platform === "win32"
		? killProcessTreeWindows(pid)
		: killProcessTreeUnix(pid, signal));
}

/**
 * Recursively builds a process tree by finding all descendants of a given PID.
 *
 * @param parentPid - The parent process ID.
 * @returns Array of all descendant PIDs (including the parent).
 */
async function buildProcessTree(parentPid: number): Promise<Array<number>> {
	const tree: Record<number, Array<number>> = { [parentPid]: [] };

	// Recursively build the tree
	const processQueue = [parentPid];

	while (processQueue.length > 0) {
		const currentPid = processQueue.shift();
		if (currentPid === undefined) {
			break;
		}

		const children = await getChildPids(currentPid);

		tree[currentPid] = children;

		for (const childPid of children) {
			tree[childPid] = [];
			processQueue.push(childPid);
		}
	}

	// Flatten tree into array (children before parents for proper kill order)
	const allPids: Array<number> = [];
	const visited = new Set<number>();

	function collectPids(pid: number): void {
		if (visited.has(pid)) {
			return;
		}

		visited.add(pid);

		// Add children first
		for (const childPid of tree[pid] ?? []) {
			collectPids(childPid);
		}

		// Then add parent
		allPids.push(pid);
	}

	collectPids(parentPid);

	return allPids;
}

/**
 * Gets child process IDs for a given parent PID.
 *
 * @param pid - The parent process ID.
 * @returns Array of child PIDs.
 */
async function getChildPids(pid: number): Promise<Array<number>> {
	try {
		const command = process.platform === "darwin" ? "pgrep" : "ps";
		const args =
			process.platform === "darwin"
				? ["-P", String(pid)]
				: ["-o", "pid", "--no-headers", "--ppid", String(pid)];

		const result = await execa(command, args);
		const output = result.stdout.trim();

		if (output.length === 0) {
			return [];
		}

		return output.split("\n").map((line) => Number.parseInt(line.trim(), 10));
	} catch {
		// Process might have no children or might have exited
		return [];
	}
}

/**
 * Kills multiple PIDs with the given signal.
 *
 * @param pids - Array of process IDs to kill.
 * @param signal - The signal to send.
 */
function killPids(pids: Array<number>, signal: string): void {
	for (const pid of pids) {
		try {
			process.kill(pid, signal as NodeJS.Signals);
		} catch (err) {
			if (err instanceof Error && "code" in err && err.code === "ESRCH") {
				// Process doesn't exist (already dead)
				continue;
			}

			throw err;
		}
	}
}

/**
 * Kills a process tree on Unix systems (macOS, Linux) by recursively finding
 * all descendants and killing them.
 *
 * @param pid - The process ID to kill.
 * @param signal - The signal to send (e.g., SIGTERM, SIGKILL).
 */
async function killProcessTreeUnix(pid: number, signal: string): Promise<void> {
	const pids = await buildProcessTree(pid);
	killPids(pids, signal);
}

/**
 * Kills a process tree on Windows using taskkill.
 *
 * @param pid - The process ID to kill.
 */
async function killProcessTreeWindows(pid: number): Promise<void> {
	try {
		await execa("taskkill", ["/pid", String(pid), "/T", "/F"]);
	} catch (err) {
		// Ignore if process doesn't exist
		if (err instanceof Error && "exitCode" in err && err.exitCode === 128) {
			return;
		}

		throw err;
	}
}
