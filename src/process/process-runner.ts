import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import path from "node:path";

import type { ChildProcessRunner } from "../seams/child-process.ts";
import type { Clock } from "../seams/clock.ts";
import type { Host } from "../seams/host.ts";
import type { Environment } from "../seams/seams.ts";
import { readVariable } from "./environment.ts";

/** How many trailing output lines a run keeps. */
export const OUTPUT_TAIL_LINES = 50;

const TRAILING_CR = /\r$/;

/**
 * One process to run to completion. `file` is an executable, never a shell
 * command line: `process/command-line.ts` builds specs for shell commands and
 * for tools.
 */
export interface ProcessSpec {
	args: ReadonlyArray<string>;
	cwd: string;
	env: Environment;
	file: string;
	/** Kill the whole process tree after this many milliseconds. */
	timeoutMs?: number;
	/**
	 * Windows only: pass `args` as written, without quoting. For cmd.exe
	 * command lines that are already escaped.
	 */
	verbatimArguments?: boolean;
}

/** How a run ended. Output is stdout and stderr together, in arrival order. */
export type ProcessOutcome =
	| {
			/** The OS error code, such as `ENOENT`. */
			errorCode: string | undefined;
			message: string;
			type: "spawn_failed";
	  }
	| {
			durationMs: number;
			/** `null` when a signal ended the process. */
			exitCode: null | number;
			outputTail: Array<string>;
			signal: NodeJS.Signals | null;
			type: "exited";
	  }
	| {
			durationMs: number;
			outputTail: Array<string>;
			type: "timed_out";
	  };

/**
 * Runs one process to completion. This is the swap point for the process
 * backend: {@link createChildProcessRunner} is the plain child-process
 * backend; the native reaper provides another with the same contract. Hooks
 * and one-shot commands only ever see this type.
 */
export type ProcessRunner = (spec: ProcessSpec) => Promise<ProcessOutcome>;

/** What the child-process backend needs. */
export interface ChildProcessBackend {
	childProcess: ChildProcessRunner;
	clock: Clock;
	host: Host;
}

interface Closed {
	exitCode: null | number;
	signal: NodeJS.Signals | null;
}

/** The output a run keeps. */
interface CollectedOutput {
	/** The kept lines; a last line with no newline is included. */
	lines: () => Array<string>;
	/** Stop reading: destroy both pipes. */
	release: () => void;
}

/**
 * The plain child-process backend. Every spawn is hidden on Windows. On POSIX
 * each process leads its own process group, so a timeout kills the whole tree
 * with one group signal; on Windows `taskkill /T` kills the tree.
 *
 * @param backend - The spawn seam, the clock for timeouts, and the host.
 * @returns A {@link ProcessRunner}.
 */
export function createChildProcessRunner(backend: ChildProcessBackend): ProcessRunner {
	return async (spec) => runChildAsync(backend, spec);
}

async function spawnErrorAsync(child: ChildProcess): Promise<NodeJS.ErrnoException> {
	return new Promise((resolve) => {
		child.once("error", resolve);
	});
}

/**
 * Wait for the process to end: `exit` when it ends, `close` once its output
 * pipes are also closed.
 *
 * @param child - The process.
 * @param event - `exit` or `close`.
 * @returns Its exit code and signal.
 */
async function waitForEventAsync(child: ChildProcess, event: "close" | "exit"): Promise<Closed> {
	return new Promise((resolve) => {
		child.once(event, (exitCode: null | number, signal: NodeJS.Signals | null) => {
			resolve({ exitCode, signal });
		});
	});
}

/**
 * Wait for the process or the timeout, whichever comes first.
 *
 * @param closed - Resolves when the process closes.
 * @param clock - Runs the timer.
 * @param timeoutMs - The limit; no limit when `undefined`.
 * @returns Whether the timeout came first.
 */
async function outlivesTimeoutAsync(
	closed: Promise<Closed>,
	clock: Clock,
	timeoutMs: number | undefined,
): Promise<boolean> {
	if (timeoutMs === undefined) {
		return false;
	}

	const abort = new AbortController();
	// An abort means the process closed first.
	const timer = clock
		.sleep(timeoutMs, abort.signal)
		.then(() => true)
		.catch(() => false);
	const isTimedOut = await Promise.race([closed.then(() => false), timer]);
	abort.abort();
	return isTimedOut;
}

/**
 * Kill a process and its descendants. POSIX signals the process group the
 * process leads; Windows runs `taskkill /T` by absolute path (the spec's PATH
 * may not reach System32) and falls back to killing the process alone.
 *
 * @param target - The process and its pid.
 * @param environment - The spec's variables, for `SystemRoot`.
 * @param backend - The spawn seam and the host.
 */
async function killTreeAsync(
	{ child, pid }: { child: ChildProcess; pid: number },
	environment: Environment,
	{ childProcess, host }: Pick<ChildProcessBackend, "childProcess" | "host">,
): Promise<void> {
	if (host.platform !== "win32") {
		try {
			host.kill(-pid, "SIGKILL");
		} catch {
			// The group is already gone.
		}

		return;
	}

	const systemRoot = readVariable(environment, "SystemRoot", "win32") ?? "C:\\Windows";
	const taskkill = childProcess.spawn(
		path.win32.join(systemRoot, "System32", "taskkill.exe"),
		["/pid", String(pid), "/T", "/F"],
		{ stdio: "ignore", windowsHide: true },
	);
	const hasRun = await new Promise<boolean>((resolve) => {
		taskkill.once("close", () => {
			resolve(true);
		});
		taskkill.once("error", () => {
			resolve(false);
		});
	});
	if (!hasRun) {
		child.kill("SIGKILL");
	}
}

/**
 * Keep the last {@link OUTPUT_TAIL_LINES} lines of a child's output.
 *
 * @param child - A child spawned with piped stdout and stderr.
 * @returns The kept lines and a way to stop reading.
 */
function collectOutput(child: ChildProcess): CollectedOutput {
	let lines: Array<string> = [];
	let partial = "";

	/**
	 * Add a chunk of output, keeping a trailing partial line for later.
	 *
	 * @param chunk - Text as it arrived; it may end mid-line.
	 */
	function write(chunk: string): void {
		const parts = `${partial}${chunk}`.split("\n");
		const last = parts.pop();
		// `split` always returns at least one part.
		assert(last !== undefined);
		partial = last;
		lines = [...lines, ...parts.map((line) => line.replace(TRAILING_CR, ""))].slice(
			-OUTPUT_TAIL_LINES,
		);
	}

	const streams = [child.stdout, child.stderr].map((stream) => {
		// Spawned with piped stdout and stderr.
		assert(stream !== null);
		stream.setEncoding("utf8");
		stream.on("data", write);
		return stream;
	});

	return {
		lines: () => (partial === "" ? lines : [...lines, partial].slice(-OUTPUT_TAIL_LINES)),
		release: () => {
			for (const stream of streams) {
				stream.destroy();
			}
		},
	};
}

function spawnChild({ childProcess, host }: ChildProcessBackend, spec: ProcessSpec): ChildProcess {
	return childProcess.spawn(spec.file, [...spec.args], {
		cwd: spec.cwd,
		detached: host.platform !== "win32",
		env: spec.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		windowsVerbatimArguments: spec.verbatimArguments === true,
	});
}

async function runChildAsync(
	backend: ChildProcessBackend,
	spec: ProcessSpec,
): Promise<ProcessOutcome> {
	const { clock } = backend;
	const startedAt = clock.now();
	const child = spawnChild(backend, spec);
	if (child.pid === undefined) {
		const error = await spawnErrorAsync(child);
		return { errorCode: error.code, message: error.message, type: "spawn_failed" };
	}

	const output = collectOutput(child);
	const exited = waitForEventAsync(child, "exit");
	const closed = waitForEventAsync(child, "close");
	if (await outlivesTimeoutAsync(closed, clock, spec.timeoutMs)) {
		await killTreeAsync({ child, pid: child.pid }, spec.env, backend);
		await exited;
		// A descendant that escaped the kill may still hold the pipes.
		output.release();
		return {
			durationMs: clock.now() - startedAt,
			outputTail: output.lines(),
			type: "timed_out",
		};
	}

	const { exitCode, signal } = await closed;
	const durationMs = clock.now() - startedAt;
	return { durationMs, exitCode, outputTail: output.lines(), signal, type: "exited" };
}
