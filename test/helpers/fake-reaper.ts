import { ForgeError } from "../../src/errors.ts";
import type { WorkerReport, WorkerSpec } from "../../src/reaper/protocol.ts";
import type {
	Reaper,
	ReaperEnd,
	ReaperLauncher,
	ReaperOptions,
	SpawnedWorker,
} from "../../src/reaper/reaper-client.ts";
import type { Signals } from "../../src/seams/signals.ts";

/** How `terminateAsync` reports a tree it stopped. */
const STOPPED: WorkerReport = { exitCode: null, forced: false, incomplete: false, signal: 15 };

/** A reaper a unit test drives by hand. */
export interface FakeReaper {
	/**
	 * What the code under test did, in order: `go`, `spawn <id>`, `terminate
	 * <ms>`.
	 */
	calls: Array<string>;
	/** End a spawned worker's tree with this report. */
	exit: (id: string, report: WorkerReport) => void;
	/** The launcher seam; it records its options. */
	launch: ReaperLauncher;
	/** Every launch's options. */
	launches: Array<Pick<ReaperOptions, "leasePath" | "sessionId">>;
	/** Every worker the code under test asked for. */
	spawned: Array<WorkerSpec>;
}

/** How a {@link FakeReaper} behaves. */
export interface FakeReaperOptions {
	/**
	 * Ends a worker right after it starts, when it returns a report: a
	 * one-shot run, such as a build or a hook.
	 */
	autoExit?: (worker: WorkerSpec) => undefined | WorkerReport;
	/** What `terminateAsync` resolves with. */
	end?: ReaperEnd;
	/** Runs inside the launch, before it resolves (for example, a signal). */
	onLaunch?: () => void;
	/** Runs inside every spawn, before it resolves. */
	onSpawn?: (worker: WorkerSpec) => void;
	/** Every spawn rejects with this. */
	spawnError?: Error;
}

/** Stop signals a unit test sends by hand. */
export interface FakeSignals {
	/** Send a stop signal to every listener. */
	fire: (signal: NodeJS.Signals) => void;
	/** How many listeners are on. */
	listeners: () => number;
	signals: Signals;
}

/** What a fake reaper records into. */
interface FakeReaperState {
	calls: Array<string>;
	exits: Map<string, (report: WorkerReport) => void>;
	/** `terminate` arrived: every later spawn is rejected. */
	isTerminated: boolean;
	options: FakeReaperOptions;
	spawned: Array<WorkerSpec>;
}

/**
 * A fake reaper launcher. Spawned workers get PIDs 100, 101, ...; their
 * trees end only when the test calls `exit`.
 *
 * @param options - How it behaves.
 * @returns The launcher and its record.
 */
export function createFakeReaper(options: FakeReaperOptions = {}): FakeReaper {
	const calls: Array<string> = [];
	const exits = new Map<string, (report: WorkerReport) => void>();
	const launches: Array<Pick<ReaperOptions, "leasePath" | "sessionId">> = [];
	const spawned: Array<WorkerSpec> = [];
	const reaper = makeReaper({ calls, exits, isTerminated: false, options, spawned });

	return {
		calls,
		exit: (id, report) => {
			exits.get(id)?.(report);
			exits.delete(id);
		},
		launch: async (launchOptions) => {
			launches.push(launchOptions);
			options.onLaunch?.();
			await nextTickAsync();
			return reaper;
		},
		launches,
		spawned,
	};
}

/**
 * A fake stop-signal seam.
 *
 * @returns The seam and its controls.
 */
export function createFakeSignals(): FakeSignals {
	const listeners = new Set<(signal: NodeJS.Signals) => void>();

	return {
		fire: (signal) => {
			for (const listener of listeners) {
				listener(signal);
			}
		},
		listeners: () => listeners.size,
		signals: {
			onStop: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
	};
}

/**
 * Wait one microtask: the real reaper answers through its pipe, never in the
 * same tick as the request.
 */
async function nextTickAsync(): Promise<void> {
	await Promise.resolve();
}

/**
 * Start a worker, as the real reaper does: in request order, so a spawn
 * sent after `terminate` is rejected.
 *
 * @param state - The fake's record.
 * @param worker - The worker to start.
 * @returns The worker; it ends when the test (or `autoExit`) says so.
 * @rejects {ForgeError} `process_failed` after `terminate`, or the
 *   configured `spawnError`.
 */
async function spawnAsync(state: FakeReaperState, worker: WorkerSpec): Promise<SpawnedWorker> {
	const { calls, exits, options, spawned } = state;
	if (state.isTerminated) {
		throw new ForgeError(
			"process_failed",
			`The reaper did not start ${worker.id}: terminating`,
		);
	}

	calls.push(`spawn ${worker.id}`);
	spawned.push(worker);
	options.onSpawn?.(worker);
	await nextTickAsync();
	if (options.spawnError !== undefined) {
		throw options.spawnError;
	}

	const { promise, resolve } = Promise.withResolvers<WorkerReport>();
	exits.set(worker.id, resolve);
	const report = options.autoExit?.(worker);
	if (report !== undefined) {
		exits.delete(worker.id);
		resolve(report);
	}

	return { id: worker.id, exited: promise, pid: 99 + spawned.length, startTime: "1" };
}

/**
 * End the fake: as the real reaper, every live tree is stopped and reported
 * before `terminated`.
 *
 * @param state - The fake's record.
 * @param graceMs - The grace time asked for.
 */
async function terminateAsync(state: FakeReaperState, graceMs: number): Promise<void> {
	state.calls.push(`terminate ${graceMs}`);
	state.isTerminated = true;
	await nextTickAsync();
	for (const [id, resolve] of state.exits) {
		state.exits.delete(id);
		resolve(STOPPED);
	}
}

function makeReaper(state: FakeReaperState): Reaper {
	const end = state.options.end ?? { reports: [], terminated: true };
	return {
		ended: Promise.resolve(end),
		go: () => {
			state.calls.push("go");
		},
		pid: 1,
		spawnAsync: async (worker) => spawnAsync(state, worker),
		stop: (id, graceMs) => {
			state.calls.push(`stop ${id} ${graceMs}`);
		},
		terminateAsync: async (graceMs) => {
			await terminateAsync(state, graceMs);
			return end;
		},
	};
}
