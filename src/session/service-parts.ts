import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { CommandContext } from "../commands/context.ts";
import { logFilePath, openLogFile } from "../output/log-file.ts";
import type { Invocation } from "../process/command-line.ts";
import type { WorkerReport } from "../reaper/protocol.ts";
import type { SpawnedWorker } from "../reaper/reaper-client.ts";
import type { Clock } from "../seams/clock.ts";
import { settlesWithinAsync } from "../seams/clock.ts";
import type { OutputFollower } from "./output-follower.ts";
import { followOutput } from "./output-follower.ts";
import type { SessionScope } from "./run-session.ts";
import type { ServiceId, StatusRecorder } from "./status.ts";

/** A long-running service of the session, resolved before it starts. */
export interface ServiceInvocation extends Invocation {
	/** Its id: the part, the worker id, and the name of its log. */
	id: ServiceId;
	/** The step name the reporter shows, such as `rojo serve`. */
	step: string;
}

/** How the session follows one service. */
export interface ServiceHooks {
	/** Its status once it runs. */
	initial: "ready" | "starting";
	/** Gets each output line. */
	onLine?: ((line: string) => void) | undefined;
	/** Called once its tree is gone and its part is `off` or `failed`. */
	onStopped?: (() => void) | undefined;
}

/** A service's part that runs. */
export interface RunningPart {
	/** Resolves once its tree is gone and its status tells how it ended. */
	stopped: Promise<void>;
}

/**
 * The session's service parts. Each one stops alone: its exit makes it
 * `failed` and leaves the session and the other parts running.
 */
export interface ServiceParts {
	/** Whether a part's service runs: started, and its tree not gone yet. */
	isRunning: (id: ServiceId) => boolean;
	/**
	 * Start a service as its part, through the reaper.
	 *
	 * @returns The running part, or `undefined` when the session is ending.
	 * @rejects `process_failed` or `reaper_unavailable`.
	 */
	startAsync: (
		service: ServiceInvocation,
		hooks: ServiceHooks,
	) => Promise<RunningPart | undefined>;
	/**
	 * Stop a running part: `off` once its tree is gone, or `failed` with
	 * `failure` (why it failed) set.
	 */
	stop: (id: ServiceId, failure?: string) => void;
	/** Stop a running part on request, and wait until its tree is gone. */
	stopAsync: (id: ServiceId) => Promise<void>;
}

/** What the service parts run with. */
export interface PartsSetup {
	context: CommandContext;
	/** `.forge/sessions/<id>`: raw worker output while the session runs. */
	directory: string;
	status: StatusRecorder;
}

/** How often the session reads a service's output. */
export const OUTPUT_POLL_MS = 250;

/** How many of its last output lines a failed part shows. */
export const PART_TAIL_LINES = 20;

/** Why a running part is being stopped. */
interface Stopping {
	/** Why it failed; unset for a stop on request. */
	failure?: string | undefined;
}

/** One running part: its worker, output tail, and a stop in progress. */
interface PartRun {
	hooks: ServiceHooks;
	service: ServiceInvocation;
	/** Resolves once its tree is gone and its status tells how it ended. */
	stopped?: Promise<void>;
	stopping?: Stopping;
	tail: Array<string>;
	worker: SpawnedWorker;
}

/**
 * Run the session's services, each as a part that stops alone.
 *
 * @param setup - The context, session directory, and status.
 * @param scope - Starts and stops the workers; its end makes a part `off`.
 * @returns Starts and stops each service's part.
 */
export function createServiceParts(setup: PartsSetup, scope: SessionScope): ServiceParts {
	const running = new Map<ServiceId, PartRun>();
	function stop(id: ServiceId, failure?: string): void {
		stopRun(scope, running.get(id), failure);
	}

	return {
		isRunning: (id) => running.has(id),
		startAsync: async (service, hooks) => {
			const started = await spawnAsync(setup, scope, service, hooks);
			if (started === undefined) {
				return;
			}

			const { follower, run } = started;
			running.set(service.id, run);
			const stopped = followPartAsync(setup, scope.signal, { follower, run }).finally(() => {
				running.delete(service.id);
			});
			run.stopped = stopped;
			scope.track(stopped);
			return { stopped };
		},
		stop,
		stopAsync: async (id) => {
			const stopped = running.get(id)?.stopped;
			stop(id);
			await stopped;
		},
	};
}

/**
 * Stop a running part once: its worker gets the graceful signal.
 *
 * @param scope - Stops the worker.
 * @param run - The part; `undefined` when it does not run.
 * @param failure - Why it failed; unset for a stop on request.
 */
function stopRun(
	scope: Pick<SessionScope, "stopWorker">,
	run: PartRun | undefined,
	failure: string | undefined,
): void {
	if (run === undefined || run.stopping !== undefined) {
		return;
	}

	run.stopping = { failure };
	scope.stopWorker(run.service.id);
}

/**
 * Start one service through the reaper. Its output goes line by line to its
 * rotated log, its tail, and `onLine`.
 *
 * @param setup - The context and the session directory.
 * @param scope - Starts the service.
 * @param service - The resolved service.
 * @param hooks - Its status once it runs, and what else gets each line.
 * @returns The part and its output reader, or `undefined` when the session
 *   is ending.
 */
async function spawnAsync(
	setup: PartsSetup,
	scope: SessionScope,
	service: ServiceInvocation,
	hooks: ServiceHooks,
): Promise<undefined | { follower: OutputFollower; run: PartRun }> {
	const { cwd, env, reporter, seams } = setup.context;
	const { clock, fileSystem } = seams;
	const spoolDirectory = path.join(setup.directory, "output");
	const spool = path.join(spoolDirectory, `${service.id}.log`);
	fileSystem.mkdirSync(spoolDirectory, { recursive: true });
	// The reaper appends: a part that starts again reads only its own output.
	fileSystem.rmSync(spool, { force: true });
	const log = openLogFile(fileSystem, logFilePath(cwd, service.id));
	const startedAt = new Date(clock.now());
	log.write(`--- forge start ${startedAt.toISOString()} ---`);

	const { step, ...invocation } = service;
	reporter.emit({ name: step, status: "started", type: "step" });
	const worker = await scope.startServiceAsync({ ...invocation, cwd, env, log: spool });
	if (worker === undefined) {
		return undefined;
	}

	reporter.emit({ name: step, status: "succeeded", type: "step" });
	setup.status.service(service.id, hooks.initial);
	const run: PartRun = { hooks, service, tail: [], worker };
	const follower = followOutput(fileSystem, spool, (line) => {
		const text = stripVTControlCharacters(line);
		log.write(text);
		run.tail = [...run.tail, text].slice(-PART_TAIL_LINES);
		hooks.onLine?.(line);
	});
	return { follower, run };
}

/**
 * Note when a service's tree is gone.
 *
 * @param worker - The service.
 * @param state - Gets `isRunning: false` once the tree is gone.
 */
async function markExitAsync(worker: SpawnedWorker, state: { isRunning: boolean }): Promise<void> {
	await worker.exited;
	state.isRunning = false;
}

/**
 * Read a service's output until its tree is gone.
 *
 * @param clock - Runs the poll timer.
 * @param worker - The service.
 * @param follower - Reads its output file.
 * @returns Its report.
 */
async function followUntilExitAsync(
	clock: Clock,
	worker: SpawnedWorker,
	follower: OutputFollower,
): Promise<WorkerReport> {
	const state = { isRunning: true };
	const exited = markExitAsync(worker, state);
	while (state.isRunning) {
		await settlesWithinAsync(clock, exited, OUTPUT_POLL_MS);
		follower.read();
	}

	follower.finish();
	return worker.exited;
}

function describeExit({ exitCode, signal }: WorkerReport): string {
	if (exitCode !== null) {
		return `exit code ${exitCode}`;
	}

	return signal === null ? "killed" : `signal ${signal}`;
}

/**
 * Read a service's output until its tree is gone, then mark its part: `off`
 * after a stop on request or the session's end, else `failed`.
 *
 * @param setup - The clock, status, and reporter.
 * @param ended - Aborts once the session ends, which stops every part on
 *   request.
 * @param part - The part and its output reader.
 * @param part.follower - Reads its output file.
 * @param part.run - Its worker, service, hooks, and output tail.
 */
async function followPartAsync(
	setup: PartsSetup,
	ended: AbortSignal,
	{ follower, run }: { follower: OutputFollower; run: PartRun },
): Promise<void> {
	const report = await followUntilExitAsync(setup.context.seams.clock, run.worker, follower);
	const { id } = run.service;
	const { stopping } = run;
	const isRequested = stopping === undefined ? ended.aborted : stopping.failure === undefined;
	if (isRequested) {
		setup.status.service(id, "off");
	} else {
		setup.status.serviceFailed(id, { exitCode: report.exitCode, outputTail: run.tail });
		const why = stopping?.failure ?? `${id} exited (${describeExit(report)})`;
		setup.context.reporter.emit({
			message: `${why}; the session goes on without it. Its output is in ${logFilePath(setup.context.cwd, id)}.`,
			type: "warning",
		});
	}

	run.hooks.onStopped?.();
}
