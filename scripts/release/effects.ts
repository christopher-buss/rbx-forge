import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
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
 * @param options - Output and environment.
 * @returns The finished process.
 */
function spawn(
	command: string,
	args: ReadonlyArray<string>,
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	const hidden = { ...options, windowsHide: true };
	return process.platform === "win32"
		? spawnSync([command, ...args].join(" "), { ...hidden, shell: true })
		: spawnSync(command, args, hidden);
}

const processes: Processes = {
	read: (command, args) => {
		const { status, stdout } = spawn(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		});
		return { status, stdout };
	},
	run: (command, args, environment) => {
		return spawn(command, args, {
			encoding: "utf8",
			env: { ...process.env, ...environment },
			stdio: "inherit",
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
export function main(step: () => void): void {
	try {
		step();
	} catch (err) {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}
`);
		process.exitCode = 1;
	}
}
