/**
 * The real spawn seam, recording each process it starts, for a test's end
 * to make sure every one is gone.
 */
import { fromAny } from "@total-typescript/shoehorn";

import type { ChildProcess, SpawnOptions } from "node:child_process";
import nodeChildProcess from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import type { ChildProcessRunner } from "../../src/seams/child-process.ts";

/** The processes a seam spawned. */
export interface SpawnRecord {
	/**
	 * Wait until every process exits after its stop. Kill those that still
	 * run once `graceMs` passed, then fail: a stop one never heard, or one
	 * that left it running, is a leak.
	 *
	 * @param stopped - Resolves once the stop was asked for.
	 * @param graceMs - How long they may take.
	 */
	killAfterGraceAsync: (stopped: Promise<void>, graceMs: number) => Promise<void>;
	runner: ChildProcessRunner;
}

/** A process the seam spawned. */
interface Spawned {
	child: ChildProcess;
	/** Resolves once it has exited, or never started. */
	exited: Promise<void>;
	readonly isRunning: boolean;
}

/**
 * The real spawn, which keeps each process it starts, with its exit.
 *
 * @returns The spawn seam, and what ends its processes.
 */
export function recordSpawns(): SpawnRecord {
	const spawned: Array<Spawned> = [];
	function spawn(file: string, args: Array<string>, options: SpawnOptions): unknown {
		const entry = track(nodeChildProcess.spawn(file, args, options));
		spawned.push(entry);
		return entry.child;
	}

	return {
		killAfterGraceAsync: async (stopped, graceMs) => {
			await killAfterGraceAsync(spawned, stopped, graceMs);
		},
		runner: { spawn: fromAny(spawn) },
	};
}

function track(child: ChildProcess): Spawned {
	let isRunning = true;
	const exited = new Promise<void>((resolve) => {
		function done(): void {
			isRunning = false;
			resolve();
		}

		child.once("close", done);
		child.once("error", done);
	});
	return {
		child,
		exited,
		get isRunning() {
			return isRunning;
		},
	};
}

async function killAfterGraceAsync(
	spawned: ReadonlyArray<Spawned>,
	stopped: Promise<void>,
	graceMs: number,
): Promise<void> {
	const exited = Promise.all(spawned.map(async ({ exited: done }) => done));
	await Promise.race([stopped.then(async () => exited), sleep(graceMs)]);
	const leaked = spawned.filter(({ isRunning }) => isRunning);
	for (const { child } of leaked) {
		child.kill("SIGKILL");
	}

	await exited;
	if (leaked.length > 0) {
		const pids = leaked.map(({ child }) => child.pid).join(", ");
		throw new Error(`still running ${graceMs} ms after the stop, killed: ${pids}`);
	}
}
