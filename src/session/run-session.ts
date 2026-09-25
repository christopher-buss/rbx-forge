import type { WorkerReport, WorkerSpec } from "../reaper/protocol.ts";
import type { Reaper, ReaperEnd, SpawnedWorker } from "../reaper/reaper-client.ts";
import type { Seams } from "../seams/seams.ts";

/** Why a session ended. */
export type SessionEndReason =
	/** A service's tree is gone: it exited, or its reaper died. */
	| { report: WorkerReport; service: string; type: "service_exited" }
	/** A stop signal (Ctrl+C, `kill`, a closed terminal). */
	| { signal: NodeJS.Signals; type: "signal" };

/** How a session ended, once every worker is gone. */
export interface SessionOutcome {
	/** The reaper's end, with every worker's report. */
	end: ReaperEnd;
	reason: SessionEndReason;
}

/** What one session runs. */
export interface SessionOptions {
	/** How long workers get to stop after the graceful signal. */
	graceMs: number;
	/** The lease file, in the session's directory. */
	leasePath: string;
	/** Called once every service runs. */
	onReady: () => void;
	/** The long-running workers, in start order. Each id names a service. */
	services: ReadonlyArray<WorkerSpec>;
	sessionId: string;
}

/** A session's stop-signal listener. */
interface StopListener {
	dispose: () => void;
	/** The first stop signal, once one arrived. */
	fired: () => NodeJS.Signals | undefined;
	/** Resolves with the first stop signal. */
	signal: Promise<NodeJS.Signals>;
}

/**
 * Run a session in this process: start its reaper, start every service
 * through it, and wait for the first end trigger (a stop signal, or any
 * service's exit). Then terminate the reaper, which stops every worker, and
 * return once it has exited. The reaper also ends every worker when this
 * process dies, however it dies.
 *
 * Admission (spec #28): the reaper gets `go` only while no stop signal has
 * arrived, and no service starts after one.
 *
 * @param seams - The reaper launcher and the stop signals.
 * @param options - The services and the session's files.
 * @returns Why the session ended and the reaper's end.
 * @rejects `reaper_unavailable`, or `process_failed` when a
 *   service cannot start. Every started worker is gone by then.
 */
export async function runSessionAsync(
	seams: Pick<Seams, "reaper" | "signals">,
	options: SessionOptions,
): Promise<SessionOutcome> {
	const stop = listenForStop(seams);
	try {
		const reaper = await seams.reaper({
			leasePath: options.leasePath,
			sessionId: options.sessionId,
		});
		try {
			const reason = await runServicesAsync(reaper, stop, options);
			return { end: await reaper.terminateAsync(options.graceMs), reason };
		} catch (err) {
			await reaper.terminateAsync(options.graceMs);
			throw err;
		}
	} finally {
		stop.dispose();
	}
}

function listenForStop({ signals }: Pick<Seams, "signals">): StopListener {
	const { promise, resolve } = Promise.withResolvers<NodeJS.Signals>();
	let fired: NodeJS.Signals | undefined;
	const dispose = signals.onStop((signal) => {
		fired ??= signal;
		resolve(signal);
	});

	return { dispose, fired: () => fired, signal: promise };
}

/**
 * Admit the reaper and start the services, unless a stop signal came first.
 *
 * @param reaper - The session's reaper, leased.
 * @param stop - The stop-signal listener.
 * @param services - The workers to start, in order.
 * @returns The services started before any stop signal.
 */
async function startServicesAsync(
	reaper: Reaper,
	stop: StopListener,
	services: ReadonlyArray<WorkerSpec>,
): Promise<Array<SpawnedWorker>> {
	const workers: Array<SpawnedWorker> = [];
	if (stop.fired() !== undefined) {
		return workers;
	}

	reaper.go();
	for (const service of services) {
		// Once a stop signal arrived, nothing more starts.
		if (stop.fired() !== undefined) {
			return workers;
		}

		workers.push(await reaper.spawnAsync(service));
	}

	return workers;
}

async function runServicesAsync(
	reaper: Reaper,
	stop: StopListener,
	options: SessionOptions,
): Promise<SessionEndReason> {
	const workers = await startServicesAsync(reaper, stop, options.services);
	if (stop.fired() === undefined) {
		options.onReady();
	}

	const ends = workers.map(async ({ id, exited }): Promise<SessionEndReason> => {
		const report = await exited;
		return { report, service: id, type: "service_exited" };
	});
	return Promise.race([
		stop.signal.then((signal): SessionEndReason => ({ signal, type: "signal" })),
		...ends,
	]);
}
