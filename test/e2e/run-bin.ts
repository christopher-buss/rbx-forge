import { Buffer } from "node:buffer";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, symlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { onTestFinished, TestRunner } from "vitest";

import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";

const REPOSITORY = path.join(import.meta.dirname, "..", "..");
// Runs after `build`: the bin imports `dist/cli.mjs`.
export const BIN = path.join(REPOSITORY, "bin", "rbx-forge.js");

const COMMAND_TIMEOUT_MS = 45_000;
const DIAGNOSTIC_RESERVE_MS = 2000;
const CLEANUP_TIMEOUT_MS = 1000;
const DIAGNOSTIC_CHARACTERS = 16_384;

export interface BinRunOptions {
	/** The built CLI entry, optionally isolated for one fixture. */
	bin?: string | undefined;
	/** Cleanup hooks cannot register more test cleanup. */
	registerCleanup?: boolean;
	/**
	 * Fail before the outer test deadline, retaining output and session files.
	 */
	timeoutMs?: number;
}

/** One finished run of the built bin. */
export interface BinRun {
	/** The forge process's pid. */
	pid: number | undefined;
	status: null | number;
	stderr: string;
	stdout: string;
}

interface ObservedBin {
	child: ChildProcessWithoutNullStreams;
	closed: Promise<null | number>;
	output: () => Pick<BinRun, "stderr" | "stdout">;
}

/**
 * Run the built bin as a real process with the current Node executable. Its
 * standard streams are pipes, so the run is never interactive.
 *
 * @param argv - Arguments after `forge`.
 * @param cwd - Working directory of the run.
 * @param environment - The run's variables; defaults to this process's,
 *   without `CI`.
 * @param options - The command deadline and test cleanup registration.
 * @returns Exit status and output.
 * @rejects When spawning fails or the command misses its deadline.
 */
export async function runBinAsync(
	argv: Array<string>,
	cwd = REPOSITORY,
	environment?: NodeJS.ProcessEnv,
	{ bin = BIN, registerCleanup = true, timeoutMs }: BinRunOptions = {},
): Promise<BinRun> {
	const child = spawn(process.execPath, [bin, ...argv], {
		cwd,
		env: environment ?? { ...process.env, CI: undefined },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const observed = observeBin(child);
	if (registerCleanup) {
		onTestFinished(async () => {
			await endBinAsync(observed);
		});
	}

	const task = TestRunner.getCurrentTest();
	const started = task?.result?.startTime;
	const remaining =
		registerCleanup && started !== undefined && task !== undefined && task.timeout > 0
			? Math.max(1, started + task.timeout - Date.now() - DIAGNOSTIC_RESERVE_MS)
			: (timeoutMs ?? COMMAND_TIMEOUT_MS);
	return waitForBinAsync(observed, argv, cwd, Math.min(timeoutMs ?? remaining, remaining));
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

function observeBin(child: ChildProcessWithoutNullStreams): ObservedBin {
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

	return {
		child,
		closed: new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		}),
		output: () => ({ stderr, stdout }),
	};
}

async function endBinAsync({ child, closed }: ObservedBin): Promise<void> {
	// Kill only this ChildProcess; inherited pipes cannot hold cleanup open.
	child.kill("SIGKILL");
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS);
		void closed
			.catch(() => null)
			.then(() => {
				clearTimeout(timer);
				resolve();
			});
	});
	child.stdin.destroy();
	child.stdout.destroy();
	child.stderr.destroy();
}

function diagnosticText(file: string): string {
	try {
		const descriptor = openSync(file, "r");
		try {
			const { size } = fstatSync(descriptor);
			const buffer = Buffer.alloc(Math.min(size, DIAGNOSTIC_CHARACTERS));
			const read = readSync(
				descriptor,
				buffer,
				0,
				buffer.length,
				Math.max(0, size - buffer.length),
			);
			return buffer.toString("utf8", 0, read);
		} finally {
			closeSync(descriptor);
		}
	} catch {
		return "";
	}
}

/**
 * Read only diagnostic files: never the endpoint token or environment.
 *
 * @param cwd - The fixture project.
 * @returns Bounded file tails from the session at the command deadline.
 */
function sessionDiagnostics(cwd: string): string {
	const forge = path.join(cwd, ".forge");
	const current = diagnosticText(path.join(forge, "current")).trim();
	const files = ["workers.ndjson", ".forge/logs/supervisor.log"];
	if (current !== "" && path.basename(current) === current) {
		files.push(
			...["state.json", "supervisor.id", "reaper.json"].map((name) => {
				return path.join(".forge", "sessions", current, name);
			}),
		);
	}

	return [
		`current: ${current}`,
		...files.map((file) => `${file}:\n${diagnosticText(path.join(cwd, file))}`),
	].join("\n");
}

function commandTimeout(
	{ child, output }: ObservedBin,
	argv: Array<string>,
	cwd: string,
	timeoutMs: number,
): Error {
	const { stderr, stdout } = output();
	return new Error(
		[
			`forge ${argv.join(" ")} timed out after ${timeoutMs}ms`,
			`cwd: ${cwd}`,
			`pid: ${child.pid}; exitCode: ${child.exitCode}; signalCode: ${child.signalCode}`,
			`stdout:\n${stdout.slice(-DIAGNOSTIC_CHARACTERS)}`,
			`stderr:\n${stderr.slice(-DIAGNOSTIC_CHARACTERS)}`,
			sessionDiagnostics(cwd),
		].join("\n"),
	);
}

async function waitForBinAsync(
	observed: ObservedBin,
	argv: Array<string>,
	cwd: string,
	timeoutMs: number,
): Promise<BinRun> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const status = await Promise.race([
			observed.closed,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					reject(commandTimeout(observed, argv, cwd, timeoutMs));
				}, timeoutMs);
			}),
		]);
		return { pid: observed.child.pid, status, ...observed.output() };
	} catch (err) {
		await endBinAsync(observed);
		throw err;
	} finally {
		clearTimeout(timer);
	}
}
