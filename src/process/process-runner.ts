import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";

import type { ChildProcessRunner } from "../seams/child-process.ts";
import type { Clock } from "../seams/clock.ts";
import type { Host } from "../seams/host.ts";
import type { Environment } from "../seams/seams.ts";

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

/**
 * The plain child-process backend. Every spawn is hidden on Windows. On POSIX
 * each process leads its own process group, so a timeout kills the whole tree
 * with one group signal; on Windows `taskkill /T` kills the tree.
 *
 * @param backend - The spawn seam, the clock for timeouts, and the host.
 * @returns A {@link ProcessRunner}.
 */
export function createChildProcessRunner({
	childProcess,
	clock,
	host,
}: ChildProcessBackend): ProcessRunner {
	return async (spec) => {
		const startedAt = clock.now();
		const child = childProcess.spawn(spec.file, [...spec.args], {
			cwd: spec.cwd,
			detached: host.platform !== "win32",
			env: spec.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			windowsVerbatimArguments: spec.verbatimArguments === true,
		});

		if (child.pid === undefined) {
			const error = await spawnErrorAsync(child);
			return { errorCode: error.code, message: error.message, type: "spawn_failed" };
		}

		const tail = collectOutput(child);
		const closed = waitForCloseAsync(child);
		const isTimedOut = await outlivesTimeoutAsync(closed, clock, spec.timeoutMs);
		if (isTimedOut) {
			await killTreeAsync(child.pid, { childProcess, host });
		}

		const { exitCode, signal } = await closed;
		const durationMs = clock.now() - startedAt;
		const outputTail = tail();

		return isTimedOut
			? { durationMs, outputTail, type: "timed_out" }
			: { durationMs, exitCode, outputTail, signal, type: "exited" };
	};
}

async function spawnErrorAsync(child: ChildProcess): Promise<NodeJS.ErrnoException> {
	return new Promise((resolve) => {
		child.once("error", resolve);
	});
}

async function waitForCloseAsync(child: ChildProcess): Promise<Closed> {
	return new Promise((resolve) => {
		child.once("close", (exitCode: null | number, signal: NodeJS.Signals | null) => {
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

async function killTreeAsync(
	pid: number,
	{ childProcess, host }: Pick<ChildProcessBackend, "childProcess" | "host">,
): Promise<void> {
	if (host.platform === "win32") {
		const taskkill = childProcess.spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		await new Promise((resolve) => {
			taskkill.once("close", resolve);
			taskkill.once("error", resolve);
		});
		return;
	}

	try {
		host.kill(-pid, "SIGKILL");
	} catch {
		// The group is already gone.
	}
}

/**
 * Keep the last {@link OUTPUT_TAIL_LINES} lines of a child's output.
 *
 * @param child - A child spawned with piped stdout and stderr.
 * @returns Reads the kept lines; a last line with no newline is included.
 */
function collectOutput(child: ChildProcess): () => Array<string> {
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

	for (const stream of [child.stdout, child.stderr]) {
		// Spawned with piped stdout and stderr.
		assert(stream !== null);
		stream.setEncoding("utf8");
		stream.on("data", write);
	}

	return () => (partial === "" ? lines : [...lines, partial].slice(-OUTPUT_TAIL_LINES));
}
