import { spawnSync } from "node:child_process";
import {
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { text } from "node:stream/consumers";

import type { Spawn } from "./worktree.ts";
import {
	resolveClaudeConfigPath,
	resolveProjectDirectory,
	runWorktreeCreate,
	trustWorktree,
} from "./worktree.ts";

/**
 * Output goes to files, not pipes: the background post-start build inherits
 * the stdio of worktrunk, and Claude Code waits until the hook's pipes close.
 * @param cwd - The project directory.
 * @returns A spawn that runs in `cwd`.
 */
function spawnToFiles(cwd: string): Spawn {
	return (command, args) => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "worktree-create-"));
		const stdoutFile = path.join(directory, "stdout");
		const stderrFile = path.join(directory, "stderr");
		const stdout = openSync(stdoutFile, "w");
		const stderr = openSync(stderrFile, "w");
		try {
			const result = spawnSync(command, args, {
				cwd,
				stdio: ["ignore", stdout, stderr],
				windowsHide: true,
			});
			process.stderr.write(readFileSync(stderrFile, "utf8"));
			return {
				error: result.error,
				status: result.status,
				stdout: readFileSync(stdoutFile, "utf8"),
			};
		} finally {
			closeSync(stdout);
			closeSync(stderr);
			// The background build can hold the files open on Windows.
			try {
				rmSync(directory, { force: true, recursive: true });
			} catch {}
		}
	};
}

function readIfPresent(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			return undefined;
		}

		throw err;
	}
}

function realpathOrUndefined(file: string): string | undefined {
	try {
		// `.native` gives the on-disk casing, as the desktop app's own key does.
		return realpathSync.native(file);
	} catch {
		return undefined;
	}
}

/**
 * Other Claude processes rewrite the config whole; swap it in one rename.
 * @param file - The config file.
 * @param contents - The new contents.
 */
function writeAtomically(file: string, contents: string): void {
	const temporary = `${file}.worktree-create-${process.pid}.tmp`;
	writeFileSync(temporary, contents);
	try {
		renameSync(temporary, file);
	} catch (err) {
		rmSync(temporary, { force: true });
		throw err;
	}
}

const result = runWorktreeCreate({
	platform: process.platform,
	spawn: spawnToFiles(resolveProjectDirectory(process.env, process.cwd())),
	stdin: await text(process.stdin),
	trust: (worktreePath) => {
		trustWorktree(worktreePath, {
			path: resolveClaudeConfigPath(process.env, os.homedir()),
			read: readIfPresent,
			realpath: realpathOrUndefined,
			write: writeAtomically,
		});
	},
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;
