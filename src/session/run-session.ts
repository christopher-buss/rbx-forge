import type { WorkerReport, WorkerSpec } from "../reaper/protocol.ts";
import type { Reaper, ReaperEnd, ReaperLauncher, SpawnedWorker } from "../reaper/reaper-client.ts";
import type { Pause } from "./pause.ts";
import type { OnStop, StopRequest } from "./stop-source.ts";

/** Why a session ended. */
export type SessionEndReason =
	/** A stop request: the owner pipe closed, or a stop signal. */
	| StopRequest
	/** A step before the services failed, or a service could not start. */
	| { error: unknown; type: "failed" }
	/** A service's tree is gone: it exited, or its reaper died. */
	| { report: WorkerReport; service: string; type: "service_exited" }
	/** Studio closed the place the session opened. */
	| { type: "studio_closed" };

/** How a session ended, once every worker is gone. */
export interface SessionOutcome {
	/** The reaper's end, with every worker's report. */
	end: ReaperEnd;
	reason: SessionEndReason;
}

/** One session's reaper and stop requests. */
export interface SessionOptions {
	/** How long workers get to stop after the graceful signal. */
	graceMs: number;
	/** The lease file, in the session's directory. */
	leasePath: string;
	/**
	 * Listens for stop requests: the supervisor's owner pipe and stop
	 * signals. A request that came before the session started ends it at
	 * once.
	 */
	onStop: OnStop;
	/** The reaper record, in the session's directory. */
	recordPath: string;
	sessionId: string;
}

/** What a session's body runs with. */
export interface SessionScope {
	/** End the session. The first reason wins; later ones do nothing. */
	end: (reason: SessionEndReason) => void;
	/** The session's reaper, admitted. */
	reaper: Reaper;
	/** Aborts once the session ends: nothing new starts after that. */
	signal: AbortSignal;
	/**
	 * Start a long-running service. Its exit ends the session.
	 *
	 * @returns The worker, or `undefined` when the session is ending.
	 * @rejects `process_failed` or `reaper_unavailable`.
	 */
	startServiceAsync: (service: WorkerSpec) => Promise<SpawnedWorker | undefined>;
	/**
	 * Keep a background task, such as a file watch. Once the reaper has
	 * ended, the session waits for every task before it returns.
	 */
	track: (task: Promise<unknown>) => void;
}

/** What starts a session: its reaper launcher, and the test pause points. */
export type SessionSeams = Readonly<{ pause: Pause; reaper: ReaperLauncher }>;

/** The parts of a session the helpers below share. */
interface SessionState {
	abort: AbortController;
	ended: Promise<SessionEndReason>;
	finish: (reason: SessionEndReason) => void;
	tasks: Array<Promise<unknown>>;
}

/**
 * Run one session: start its reaper, run `body` (the steps, services, and
 * watches), and wait for the first end trigger: a stop request, a service's
 * exit, a failed step, or a reason `body` passes to `end`. Then terminate the
 * reaper, which stops every worker, and return once it has exited and every
 * tracked task has settled. The reaper also ends every worker when this
 * process dies, however it dies.
 *
 * Admission (spec #28): the reaper gets `go` only while no end trigger has
 * fired, and nothing starts after one. Once the session ends, admission is
 * closed for good: `go` is never sent later, and the body never runs.
 *
 * @param seams - The reaper launcher and the test pause points.
 * @param options - The session's files, grace time, and stop requests.
 * @param body - Starts what the session runs. A rejection ends the session
 *   with `failed`.
 * @returns Why the session ended and the reaper's end.
 * @rejects `reaper_unavailable` when the reaper does not start.
 */
export async function runSessionAsync(
	seams: SessionSeams,
	options: SessionOptions,
	body: (scope: SessionScope) => Promise<void>,
): Promise<SessionOutcome> {
	const state = createState();
	const dispose = options.onStop(state.finish);
	try {
		const reaper = await seams.reaper({
			leasePath: options.leasePath,
			recordPath: options.recordPath,
			sessionId: options.sessionId,
		});
		admit(seams.pause, state, reaper, body);

		const reason = await state.ended;
		const end = await reaper.terminateAsync(options.graceMs);
		await settleTasksAsync(state.tasks);
		return { end, reason };
	} finally {
		dispose();
	}
}

/**
 * End the session once a service's tree is gone.
 *
 * @param state - The session.
 * @param id - The service's id.
 * @param exited - Resolves with its report.
 */
async function endOnExitAsync(
	state: SessionState,
	id: string,
	exited: Promise<WorkerReport>,
): Promise<void> {
	const report = await exited;
	state.finish({ report, service: id, type: "service_exited" });
}

function makeScope(state: SessionState, reaper: Reaper): SessionScope {
	const { signal } = state.abort;
	return {
		end: state.finish,
		reaper,
		signal,
		startServiceAsync: async (service) => {
			if (signal.aborted) {
				return;
			}

			const worker = await reaper.spawnAsync(service);
			state.tasks.push(endOnExitAsync(state, service.id, worker.exited));
			return worker;
		},
		track: (task) => {
			state.tasks.push(task);
		},
	};
}

function hasEnded(state: SessionState): boolean {
	return state.abort.signal.aborted;
}

/**
 * The steps of {@link admit}.
 *
 * @param pause - The test pause points.
 * @param state - The session.
 * @param reaper - The leased reaper.
 * @param body - What the session runs.
 * @rejects What the body rejects with.
 */
async function admitAsync(
	pause: Pause,
	state: SessionState,
	reaper: Reaper,
	body: (scope: SessionScope) => Promise<void>,
): Promise<void> {
	await pause("leased", state.abort.signal);
	if (hasEnded(state)) {
		return;
	}

	reaper.go();
	await pause("admitted", state.abort.signal);
	if (!hasEnded(state)) {
		await body(makeScope(state, reaper));
	}
}

/**
 * Admit the reaper and run the body, unless the session ended first. Runs
 * as a tracked task, so the test pause points before and after `go` never
 * hold up the session's end.
 *
 * @param pause - The test pause points.
 * @param state - The session.
 * @param reaper - The leased reaper.
 * @param body - What the session runs.
 */
function admit(
	pause: Pause,
	state: SessionState,
	reaper: Reaper,
	body: (scope: SessionScope) => Promise<void>,
): void {
	const admitted = admitAsync(pause, state, reaper, body).catch((err: unknown) => {
		state.finish({ error: err, type: "failed" });
	});
	state.tasks.push(admitted);
}

/**
 * Wait until every task has settled, including tasks that settling ones
 * added meanwhile.
 *
 * @param tasks - The tracked tasks; it may grow while this waits.
 */
async function settleTasksAsync(tasks: ReadonlyArray<Promise<unknown>>): Promise<void> {
	let settled = 0;
	while (settled < tasks.length) {
		settled = tasks.length;
		await Promise.allSettled(tasks);
	}
}

function createState(): SessionState {
	const abort = new AbortController();
	const { promise, resolve } = Promise.withResolvers<SessionEndReason>();
	return {
		abort,
		ended: promise,
		finish: (reason) => {
			// Both do nothing after the first call: the first reason wins.
			abort.abort();
			resolve(reason);
		},
		tasks: [],
	};
}
