import { log } from "@clack/prompts";

import ansis from "ansis";
import fs from "node:fs/promises";

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
