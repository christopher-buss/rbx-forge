import { log } from "@clack/prompts";

import ansis from "ansis";
import fs from "node:fs/promises";

export async function cleanupLockfile(lockFilePath: string): Promise<void> {
	const maxRetries = 5;
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
