import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

/**
 * Create a real directory for one test, filled with `files`, and remove it
 * when the test finishes.
 *
 * @param files - Relative path to content.
 * @returns The absolute directory path.
 */
export function makeTemporaryDirectory(files: Record<string, string> = {}): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "rbx-forge-test-"));
	onTestFinished(() => {
		rmSync(directory, { force: true, recursive: true });
	});

	for (const [name, content] of Object.entries(files)) {
		writeFileSync(path.join(directory, name), content);
	}

	return directory;
}
