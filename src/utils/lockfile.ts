import { log } from "@clack/prompts";

import ansis from "ansis";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { ResolvedConfig } from "../config/schema";

/**
 * Maximum number of retry attempts for lockfile cleanup when file is busy
 * (common on Windows).
 */
const MAX_LOCKFILE_CLEANUP_RETRIES = 10;

/** Base delay in milliseconds for exponential backoff between retry attempts. */
const BASE_RETRY_DELAY_MS = 100;

/**
 * Removes a lockfile with retry logic for EBUSY errors.
 *
 * This is used for Studio lockfile cleanup. Retries with exponential backoff if
 * the file is busy (common on Windows).
 *
 * @param lockFilePath - Absolute path to the lockfile to remove.
 */
export async function cleanupLockfile(lockFilePath: string): Promise<void> {
	for (let attempt = 0; attempt < MAX_LOCKFILE_CLEANUP_RETRIES; attempt++) {
		try {
			await fs.rm(lockFilePath);
			return;
		} catch (err) {
			const isCleanedUp = err instanceof Error && "code" in err && err.code === "ENOENT";
			if (isCleanedUp) {
				return;
			}

			const isEbusy = err instanceof Error && "code" in err && err.code === "EBUSY";
			const isLastAttempt = attempt === MAX_LOCKFILE_CLEANUP_RETRIES - 1;
			if (isEbusy && !isLastAttempt) {
				const delayMs = BASE_RETRY_DELAY_MS * 2 ** attempt;
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
 * Constructs the full path to a lockfile from config and suffix.
 *
 * @param config - The resolved project configuration.
 * @param suffix - The lockfile suffix (e.g., ".lock", ".rojo.lock").
 * @returns Absolute path to the lockfile.
 */
export function getLockFilePath(config: ResolvedConfig, suffix: string): string {
	const projectPath = process.cwd();
	return path.join(projectPath, config.buildOutputPath + suffix);
}

/**
 * Reads a lockfile and returns its contents as lines.
 *
 * @param lockPath - Path to the lockfile.
 * @returns Array of lines from the lockfile, or null if file doesn't exist.
 */
export async function readLockfileRaw(lockPath: string): Promise<Array<string> | null> {
	try {
		const contents = await fs.readFile(lockPath, "utf-8");
		return contents.split("\n");
	} catch (err) {
		// File doesn't exist - this is expected if no process is running
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			return null;
		}

		const errorMessage = err instanceof Error ? err.message : String(err);
		log.warn(`Failed to read lockfile: ${errorMessage}`);
		return null;
	}
}
