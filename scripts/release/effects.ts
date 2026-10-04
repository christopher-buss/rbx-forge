import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";

import { withVariables } from "../../src/process/environment.ts";
import { resolveTool, toolInvocation } from "../../src/process/resolve-tool.ts";
import { nodeFileSystem } from "../../src/seams/file-system.ts";
import { nodeHost } from "../../src/seams/host.ts";
import type { Processes, PublishDependencies, ReleaseFiles } from "./release.ts";

/**
 * Find a command on `PATH` as forge finds a tool: a `.cmd` shim runs through
 * cmd.exe with its arguments escaped, an executable runs directly.
 * @param command - The program, such as `pnpm`.
 * @param args - Plain arguments.
 * @param options - Output and environment.
 * @returns The finished process.
 */
function spawn(
	command: string,
	args: ReadonlyArray<string>,
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	const lookup = {
		cwd: process.cwd(),
		env: process.env,
		fileSystem: nodeFileSystem,
		host: nodeHost,
	};
	const tool = resolveTool(command, lookup);
	if (tool === undefined) {
		throw new Error(`${command} is not on PATH`);
	}

	const invocation = toolInvocation(tool, args, lookup);
	return spawnSync(invocation.file, invocation.args, {
		...options,
		windowsHide: true,
		windowsVerbatimArguments: invocation.verbatimArguments === true,
	});
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
			env: withVariables(process.env, environment ?? {}, process.platform),
			stdio: "inherit",
		}).status;
	},
};

export const files: ReleaseFiles = {
	copy: copyFileSync,
	exists: existsSync,
	mkdir: (directory) => {
		mkdirSync(directory, { recursive: true });
	},
	read: (file) => readFileSync(file, "utf8"),
	readBytes: (file) => readFileSync(file),
	remove: (directory) => {
		rmSync(directory, { force: true, recursive: true });
	},
	write: writeFileSync,
	writeBytes: writeFileSync,
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
