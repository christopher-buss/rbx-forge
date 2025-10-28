import { log } from "@clack/prompts";

import ansis from "ansis";
import fs from "node:fs/promises";

/**
 * Removes a lockfile with retry logic for EBUSY errors.
 *
 * This is used for Studio lockfile cleanup. Retries with exponential backoff if
 * the file is busy (common on Windows).
 *
 * @param lockFilePath - Absolute path to the lockfile to remove.
 */
export async function cleanupLockfile(lockFilePath: string): Promise<void> {
	const maxRetries = 10;
	const baseDelayMs = 100;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			await fs.rm(lockFilePath);
			return;
		} catch (err) {
			const isCleanedUp = err instanceof Error && "code" in err && err.code === "ENOENT";
			if (isCleanedUp) {
				return;
			}

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
