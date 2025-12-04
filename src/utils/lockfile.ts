import ansis from "ansis";
import path from "node:path";
import { cwd } from "node:process";

import type { ResolvedConfig } from "../config/schema";
import { logger } from "./logger";

/** Maximum number of retry attempts for lockfile cleanup when file is busy. */
const MAX_LOCKFILE_CLEANUP_RETRIES = 10;

/** Base delay in milliseconds for exponential backoff between retry attempts. */
const BASE_RETRY_DELAY_MS = 100;

/**
 * Removes a lockfile with retry logic for EBUSY errors.
 *
 * @param lockFilePath - Absolute path to the lockfile to remove.
 */
export async function cleanupLockfile(lockFilePath: string): Promise<void> {
	const file = Bun.file(lockFilePath);

	for (let attempt = 0; attempt < MAX_LOCKFILE_CLEANUP_RETRIES; attempt++) {
		try {
			const isRealFile = await file.exists();
			if (!isRealFile) {
				return;
			}

			await file.delete();
			return;
		} catch (err) {
			const isEbusy = err instanceof Error && "code" in err && err.code === "EBUSY";
			const isLastAttempt = attempt === MAX_LOCKFILE_CLEANUP_RETRIES - 1;
			if (isEbusy && !isLastAttempt) {
				const delayMs = BASE_RETRY_DELAY_MS * 2 ** attempt;
				await Bun.sleep(delayMs);
				continue;
			}

			const errorMessage = err instanceof Error ? err.message : String(err);
			logger.warn(
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
	const projectPath = cwd();
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
		const file = Bun.file(lockPath);
		const isRealFile = await file.exists();

		if (!isRealFile) {
			return null;
		}

		const contents = await file.text();
		return contents.split("\n");
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		logger.warn(`Failed to read lockfile: ${errorMessage}`);
		return null;
	}
}

/**
 * Writes content to a lockfile.
 *
 * @param lockPath - Path to the lockfile.
 * @param content - Content to write.
 */
export async function writeLockfile(lockPath: string, content: string): Promise<void> {
	await Bun.write(lockPath, content);
}
