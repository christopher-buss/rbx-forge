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
	/** End the process: its streams end, then `close` fires. */
	close: (exitCode: null | number, signal?: NodeJS.Signals | null) => void;
	pid: number | undefined;
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
 * A fake child-process seam. Each spawn makes a child with pid 1000 + n.
 * `behave` runs on the next tick after the spawn, so the code under test can
 * attach its listeners first; the default leaves the child running.
 *
 * @param behave - What each child does once spawned.
 * @returns The seam and a record of the calls.
 */
export function createFakeSpawner(behave: SpawnBehavior = doNothing): FakeSpawner {
	const calls: Array<SpawnCall> = [];
	const children: Array<FakeChild> = [];

	function spawn(file: string, args: Array<string>, options: Record<string, unknown>): unknown {
		const call = { args, file, options };
		const emitter = new EventEmitter();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const child: FakeChild = {
			close: (exitCode, signal = null) => {
				stdout.end();
				stderr.end();
				setImmediate(() => {
					emitter.emit("close", exitCode, signal);
				});
			},
			pid: 1000 + calls.length,
			stderr,
			stdout,
		};
		calls.push(call);
		children.push(child);
		setImmediate(() => {
			behave(child, call);
		});

		return Object.assign(emitter, { pid: child.pid, stderr, stdout });
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

function doNothing(): void {
	// The child keeps running until the test closes it.
}
