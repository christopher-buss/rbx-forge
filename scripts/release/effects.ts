import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import process from "node:process";

import type { Processes, PublishDependencies, ReleaseFiles } from "./release.ts";

/**
 * `pnpm`, `npm`, and `gh` can be `.cmd` shims on Windows, which only a shell
 * runs. The arguments are fixed words and repository paths, so one command
 * line needs no escaping.
 * @param command - The program.
 * @param args - Its arguments.
 * @returns What to pass to `spawnSync`.
 */
function commandLine(
	command: string,
	args: ReadonlyArray<string>,
): [string, ReadonlyArray<string>, boolean] {
	return process.platform === "win32"
		? [[command, ...args].join(" "), [], true]
		: [command, args, false];
}

const processes: Processes = {
	read: (command, args) => {
		const [file, rest, shouldUseShell] = commandLine(command, args);
		const result = spawnSync(file, rest, {
			encoding: "utf8",
			shell: shouldUseShell,
			stdio: ["ignore", "pipe", "inherit"],
			windowsHide: true,
		});
		return { status: result.status, stdout: result.stdout };
	},
	run: (command, args, environment) => {
		const [file, rest, shouldUseShell] = commandLine(command, args);
		return spawnSync(file, rest, {
			env: { ...process.env, ...environment },
			shell: shouldUseShell,
			stdio: "inherit",
			windowsHide: true,
		}).status;
	},
};

export const files: ReleaseFiles = {
	chmod: chmodSync,
	copy: copyFileSync,
	exists: existsSync,
	mkdir: (directory) => {
		mkdirSync(directory, { recursive: true });
	},
	read: (file) => readFileSync(file, "utf8"),
	remove: (directory) => {
		rmSync(directory, { force: true, recursive: true });
	},
	write: writeFileSync,
};

export const publishDependencies: PublishDependencies = {
	...processes,
	files,
	log: (message) => {
		process.stderr.write(`${message}\n`);
	},
};

/** Where the native artifacts land and where the platform packages stage. */
export const ARTIFACTS = "reaper/target/artifacts";
export const STAGING = "reaper/target/npm";

/**
 * Run a release step and turn a thrown error into exit code 1.
 * @param step - The release step to run.
 */
export function main(step: () => 0 | 1 | void): void {
	try {
		process.exitCode = step() ?? 0;
	} catch (err) {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 1;
	}
}
