import { spawn } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { onTestFinished } from "vitest";

import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";

const REPOSITORY = path.join(import.meta.dirname, "..", "..");
// Runs after `build`: the bin imports `dist/cli.mjs`.
const BIN = path.join(REPOSITORY, "bin", "rbx-forge.js");

/** One finished run of the built bin. */
export interface BinRun {
	status: null | number;
	stderr: string;
	stdout: string;
}

/**
 * Run the built bin as a real process with the current Node executable. Its
 * standard streams are pipes, so the run is never interactive.
 *
 * @param argv - Arguments after `forge`.
 * @param cwd - Working directory of the run.
 * @param environment - Variables to set on top of this process's.
 * @returns Exit status and output.
 */
export async function runBinAsync(
	argv: Array<string>,
	cwd = REPOSITORY,
	environment: Record<string, string> = {},
): Promise<BinRun> {
	const child = spawn(process.execPath, [BIN, ...argv], {
		cwd,
		env: { ...process.env, CI: undefined, ...environment },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});

	onTestFinished(() => {
		child.kill();
	});

	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.stdin.end();

	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (status) => {
			resolve({ status, stderr, stdout });
		});
	});
}

/**
 * A temporary project whose `node_modules/rbx-forge` links to this
 * repository, so a config file that imports `rbx-forge` loads the built
 * library, as it does for a user.
 *
 * @param files - Files to create, by relative path.
 * @returns The project directory.
 */
export function makeProject(files: Record<string, string> = {}): string {
	const project = makeTemporaryDirectory(files);
	mkdirSync(path.join(project, "node_modules"));
	symlinkSync(REPOSITORY, path.join(project, "node_modules", "rbx-forge"), "junction");
	return project;
}
