import { log } from "@clack/prompts";

import ansis from "ansis";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { LOCKFILE_NAME } from "../constants";

/**
 * Adds a process ID to the shared lock file.
 *
 * @param pid - The process ID to add.
 */
export async function addPidToLockfile(pid: number): Promise<void> {
	const lockFilePath = getLockfilePath();
	const existingPids = await readLockfilePids();

	if (existingPids.includes(pid)) {
		return;
	}

	const allPids = [...existingPids, pid];
	const content = `${allPids.join("\n")}\n`;

	await fs.writeFile(lockFilePath, content, "utf-8");
}

export async function cleanupLockfile(lockFilePath: string): Promise<void> {
	const maxRetries = 10;
	const baseDelayMs = 100;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			await fs.rm(lockFilePath);
			return;
		} catch (err) {
			const isEbusy = err instanceof Error && "code" in err && err.code === "EBUSY";
			const isLastAttempt = attempt === maxRetries - 1;
			if (isEbusy && !isLastAttempt) {
				const delayMs = baseDelayMs * 2 ** attempt;
				await new Promise((resolve) => {
					setTimeout(resolve, delayMs);
				});
				continue;
			}

			const errorMessage = err instanceof Error ? err.message : String(err);
			log.warn(
				`Failed to clean up lockfile: ${errorMessage}\n` +
					`Please manually delete: ${ansis.cyan(lockFilePath)}`,
			);
			return;
		}
	}
}

/**
 * Reads all process IDs from the shared lock file.
 *
 * @returns Array of PIDs, or empty array if lock file doesn't exist.
 */
export async function readLockfilePids(): Promise<Array<number>> {
	const lockFilePath = getLockfilePath();

	try {
		const content = await fs.readFile(lockFilePath, "utf-8");
		const lines = content.trim().split("\n");

		return lines
			.map((line) => Number.parseInt(line.trim(), 10))
			.filter((pid) => !Number.isNaN(pid) && pid > 0);
	} catch (err) {
		// Lock file doesn't exist or can't be read
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			return [];
		}

		throw err;
	}
}

/**
 * Removes a specific process ID from the shared lock file.
 *
 * @param pid - The process ID to remove.
 */
export async function removePidFromLockfile(pid: number): Promise<void> {
	const lockFilePath = getLockfilePath();
	const existingPids = await readLockfilePids();
	const updatedPids = existingPids.filter((existingPid) => existingPid !== pid);

	// If no PIDs remain, delete the lock file
	if (updatedPids.length === 0) {
		await cleanupLockfile(lockFilePath);
		return;
	}

	const content = `${updatedPids.join("\n")}\n`;
	await fs.writeFile(lockFilePath, content, "utf-8");
}

/**
 * Gets the absolute path to the shared lock file.
 *
 * @returns The lock file path.
 */
function getLockfilePath(): string {
	return path.join(process.cwd(), LOCKFILE_NAME);
}
