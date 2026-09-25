import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { onTestFinished } from "vitest";

/** Tries to remove a directory that a dying process still holds. */
const REMOVE_TRIES = 50;
const REMOVE_RETRY_MS = 100;

/**
 * Create a real directory for one test, filled with `files`, and remove it
 * when the test finishes.
 *
 * @param files - Relative path to content.
 * @returns The absolute, symlink-free directory path.
 */
export function makeTemporaryDirectory(files: Record<string, string> = {}): string {
	// Canonical path: macOS `os.tmpdir()` is under the `/var` symlink, and
	// tools such as c12 report `/private/var` paths.
	const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rbx-forge-test-")));
	onTestFinished(async () => {
		await removeAsync(directory);
	});

	for (const [name, content] of Object.entries(files)) {
		writeFileSync(path.join(directory, name), content);
	}

	return directory;
}

/**
 * Remove a directory tree, retrying while Windows still holds it: it frees a
 * killed process's directory handles a moment after the process is gone,
 * and `rmSync`'s own `maxRetries` does not cover that `EPERM`.
 *
 * @param directory - The tree to remove.
 * @rejects The last removal error, once every try failed.
 */
async function removeAsync(directory: string): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			rmSync(directory, { force: true, recursive: true });
			return;
		} catch (err) {
			if (attempt >= REMOVE_TRIES) {
				throw err;
			}

			await sleep(REMOVE_RETRY_MS);
		}
	}
}
