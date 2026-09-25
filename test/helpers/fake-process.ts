import { fromAny } from "@total-typescript/shoehorn";

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { ChildProcessRunner } from "../../src/seams/child-process.ts";

/** One call the fake `spawn` got. */
export interface SpawnCall {
	args: Array<string>;
	file: string;
	options: Record<string, unknown>;
}

/** A child process a test drives by hand. */
export interface FakeChild {
	/** End the process: its streams end, then `exit` and `close` fire. */
	close: (exitCode: null | number, signal?: NodeJS.Signals | null) => void;
	/**
	 * End the process while a descendant keeps its pipes: only `exit` fires.
	 */
	exit: (exitCode: null | number, signal?: NodeJS.Signals | null) => void;
	/** Signals sent through the process's own `kill`, in order. */
	kills: Array<NodeJS.Signals>;
	pid: number | undefined;
	/** False once forge called `unref`, letting it exit before the child. */
	referenced: boolean;
	stderr: PassThrough;
	stdout: PassThrough;
}

/** A fake `spawn` and every process it made. */
export interface FakeSpawner {
	calls: Array<SpawnCall>;
	children: Array<FakeChild>;
	runner: ChildProcessRunner;
}

/** How the next spawned process behaves, decided when it is spawned. */
export type SpawnBehavior = (child: FakeChild, call: SpawnCall) => void;

/**
 * A fake child-process seam. Each spawn makes a child with pid 1000 + n;
 * `kill` ends it as the signal would. `behave` runs on the next tick after
 * the spawn, so the code under test can attach its listeners first; the
 * default leaves the child running.
 *
 * @param behave - What each child does once spawned.
 * @returns The seam and a record of the calls.
 */
export function createFakeSpawner(behave: SpawnBehavior = doNothing): FakeSpawner {
	const calls: Array<SpawnCall> = [];
	const children: Array<FakeChild> = [];

	function spawn(file: string, args: Array<string>, options: Record<string, unknown>): unknown {
		const call = { args, file, options };
		const { child, spawned } = makeFakeChild(1000 + calls.length);
		calls.push(call);
		children.push(child);
		setImmediate(() => {
			behave(child, call);
		});

		return spawned;
	}

	return { calls, children, runner: { spawn: fromAny(spawn) } };
}

/**
 * A fake child-process seam whose every spawn fails, as a missing executable
 * does: no pid, then an `error` event.
 *
 * @param code - The error code, such as `ENOENT`.
 * @returns The seam.
 */
export function createFailingSpawner(code: string): ChildProcessRunner {
	function spawn(file: string): unknown {
		const emitter = new EventEmitter();
		setImmediate(() => {
			emitter.emit("error", Object.assign(new Error(`spawn ${file} ${code}`), { code }));
		});

		return Object.assign(emitter, { pid: undefined, stderr: null, stdout: null });
	}

	return { spawn: fromAny(spawn) };
}

/**
 * Emit events on the next tick, after the code under test has listened.
 *
 * @param emitter - The fake process.
 * @param events - Event names, in order.
 * @param values - The arguments of each event.
 */
function emitLater(
	emitter: EventEmitter,
	events: ReadonlyArray<string>,
	values: ReadonlyArray<unknown>,
): void {
	setImmediate(() => {
		for (const event of events) {
			emitter.emit(event, ...values);
		}
	});
}

/**
 * The members of the object `spawn` returns, besides its events.
 *
 * @param child - The test's handle, which the members update.
 * @returns `kill`, `unref`, the pid, and the streams.
 */
function processMembers(child: FakeChild): object {
	return {
		kill: (signal: NodeJS.Signals) => {
			child.kills.push(signal);
			child.close(null, signal);
			return true;
		},
		pid: child.pid,
		stderr: child.stderr,
		stdout: child.stdout,
		unref: () => {
			child.referenced = false;
		},
	};
}

/**
 * A fake child process and the object `spawn` returns for it.
 *
 * @param pid - Its pid.
 * @returns The test's handle and the spawned process.
 */
function makeFakeChild(pid: number): { child: FakeChild; spawned: EventEmitter } {
	const emitter = new EventEmitter();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const child: FakeChild = {
		close: (exitCode, signal = null) => {
			stdout.end();
			stderr.end();
			emitLater(emitter, ["exit", "close"], [exitCode, signal]);
		},
		exit: (exitCode, signal = null) => {
			emitLater(emitter, ["exit"], [exitCode, signal]);
		},
		kills: [],
		pid,
		referenced: true,
		stderr,
		stdout,
	};

	return { child, spawned: Object.assign(emitter, processMembers(child)) };
}

function doNothing(): void {
	// The child keeps running until the test closes it.
}
