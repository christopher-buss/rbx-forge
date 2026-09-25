import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

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
	onTestFinished(() => {
		rmSync(directory, { force: true, recursive: true });
	});

	for (const [name, content] of Object.entries(files)) {
		writeFileSync(path.join(directory, name), content);
	}

	return directory;
}
