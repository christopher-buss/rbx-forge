import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { buildAsync } from "../commands/build.ts";
import { compileAsync } from "../commands/compile.ts";
import type { CommandContext } from "../commands/context.ts";
import { openPlaceAsync } from "../commands/open.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import { logFilePath, openLogFile } from "../output/log-file.ts";
import type { Invocation } from "../process/command-line.ts";
import type { SpawnedWorker } from "../reaper/reaper-client.ts";
import type { Clock } from "../seams/clock.ts";
import { settlesWithinAsync } from "../seams/clock.ts";
import type { StudioProcess } from "../studio/launcher.ts";
import { studioLockPath } from "../studio/lock-file.ts";
import type { BuildWatch } from "./build-watch.ts";
import type { OutputFollower } from "./output-follower.ts";
import { followOutput } from "./output-follower.ts";
import type { SessionPlan } from "./plan.ts";
import { createReaperRunner } from "./reaper-runner.ts";
import type { SessionScope } from "./run-session.ts";
import type { SessionSync } from "./session-sync.ts";
import type { SyncbackCheck } from "./session-syncback.ts";
import { checkSyncbackOnce, startSyncback, watchSavesForSyncback } from "./session-syncback.ts";
import type { StatusRecorder } from "./status.ts";
import type { SaveWatch, WatchOptions } from "./watch.ts";
import { waitForStudioCloseAsync } from "./watch.ts";

/** A long-running service of the session, resolved before it starts. */
export interface ServiceInvocation extends Invocation {
	/** Its id: the worker id and the name of its log. */
	id: "compiler" | "rojo";
	/** The step name the reporter shows, such as `rojo serve`. */
	step: string;
}

/** Everything one dev session runs with. */
export interface SessionSetup {
	/** Reads the compiler's builds, for `status` and `status --wait`. */
	builds: Pick<BuildWatch, "fail" | "read">;
	/** The compiler service, when the plan has one. */
	compiler: undefined | { parsesDiagnostics: boolean; service: ServiceInvocation };
	config: ResolvedConfig;
	/** The command's context: project root, environment, seams, reporter. */
	context: CommandContext;
	/** `.forge/sessions/<id>`: raw worker output while the session runs. */
	directory: string;
	plan: SessionPlan;
	rojo: ServiceInvocation;
	/** Gets what the session does, for `status` and `state.json`. */
	status: StatusRecorder;
	/** Gets the session's syncback runner, for `forge sync`. */
	sync: Pick<SessionSync, "attach" | "close">;
}

/** How the session body follows one service. */
interface ServiceHooks {
	/** Its status once it runs. */
	initial: "ready" | "starting";
	/** Gets each output line. */
	onLine?: ((line: string) => void) | undefined;
	/** Called once its tree is gone. */
	onStopped?: (() => void) | undefined;
}

/** The place the session opened, and the Studio it started. */
interface OpenedStudio {
	place: string;
	process: null | StudioProcess;
}

/** How often the session reads a service's output. */
export const OUTPUT_POLL_MS = 250;
/** How often the session looks at the place and Studio's lock file. */
export const FILE_POLL_MS = 500;

/** A promise that never settles: a pause that only time or a signal ends. */
const NEVER = new Promise<void>(() => {
	// Never resolves.
});

/** How often the session checks whether Rojo listens on its port. */
const ROJO_LISTEN_POLL_MS = 100;
/**
 * How long Rojo gets to listen on its port once it runs. Rojo builds the
 * whole project tree before it listens, so a big project takes a while.
 */
export const ROJO_LISTEN_BOUND_MS = 60_000;
/**
 * How long a session whose Studio closed waits for syncback before it ends:
 * a save just before the close still syncs back.
 */
export const STUDIO_CLOSED_SYNCBACK_MS = 30_000;

/**
 * The body of a dev session, for
 * `runSessionAsync`:
 *
 * 1. With syncback on, check that Rojo has syncback, before anything runs.
 * 2. Compile (roblox-ts) and build once, when the session has a compiler.
 * 3. Open the place in Studio, and end the session when Studio closes it,
 *    once a save just before the close has synced back.
 * 4. Start Rojo and the watch-mode compiler. Each is a service: its exit
 *    ends the session.
 * 5. Run syncback and its hooks for `forge sync` and, with syncback on,
 *    on each place save: one run at a time, with requests during a run
 *    folded into one more run. Rojo's syncback support is checked once per
 *    session.
 *
 * Every process runs as a worker of the session's reaper, hooks included, so
 * each stops with the session. Studio alone is launched outside it. Each
 * service's output goes to its rotated log (`.forge/logs/<id>.log`); steps
 * log to `start.log`, syncback runs to `syncback.log`.
 *
 * @param session - The config, plan, resolved services, and context.
 * @returns Starts the session's steps, services, and watches.
 */
export function createSessionBody(session: SessionSetup): (scope: SessionScope) => Promise<void> {
	return async (scope) => {
		const requireSyncback = checkSyncbackOnce(session.config);
		const opened = await runStepsAsync(session, scope, requireSyncback);
		const syncback = startSyncback(session, scope, {
			context: workerContext(session, scope, "syncback"),
			requireSyncback,
		});
		// The save watch starts once Rojo serves; until then no save is seen.
		const saves: Pick<SaveWatch, "check"> = { check: noSaveWatch };
		if (opened !== undefined) {
			async function flushSyncbackAsync(): Promise<void> {
				saves.check();
				await syncback.settled();
			}

			scope.track(watchStudioAsync(session, scope, { ...opened, flushSyncbackAsync }));
		}

		await startServicesAsync(session, scope);
		// A stop request while the services started: the session is ending.
		if (!(await waitForRojoAsync(session, scope))) {
			return;
		}

		announceReady(session);
		if (session.plan.syncback) {
			const watch = watchSavesForSyncback(session, watchOptions(session, scope), syncback);
			saves.check = watch.check;
			// The watch ends with the session either way; tracking orders it.
			// Stryker disable next-line CallExpression: equivalent
			scope.track(watch.done);
		}
	};
}

function noSaveWatch(): void {
	// No save watch runs: syncback runs only for `forge sync`.
}

/**
 * Read the watch-mode compiler's output as builds, and report each one. Once
 * the compiler stops, every wait for a build fails.
 *
 * @param session - The session's builds and reporter.
 * @returns What its service reads each line with, and does once it stopped.
 */
function compileReader(session: SessionSetup): Pick<ServiceHooks, "onLine" | "onStopped"> {
	return {
		onLine: (line) => {
			const build = session.builds.read(line);
			if (build !== undefined) {
				const { diagnostics, errors } = build;
				session.context.reporter.emit({ diagnostics, errors, type: "compiled" });
			}
		},
		onStopped: () => {
			session.builds.fail(
				new ForgeError("service_failed", "The compiler stopped, so no build comes.", {
					details: { reason: "service_failed:compiler" },
					hint: `Its output is in ${logFilePath(session.context.cwd, "compiler")}.`,
				}),
			);
		},
	};
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
 */
async function followUntilExitAsync(
	clock: Clock,
	worker: SpawnedWorker,
	follower: OutputFollower,
): Promise<void> {
	const state = { isRunning: true };
	const exited = markExitAsync(worker, state);
	while (state.isRunning) {
		await settlesWithinAsync(clock, exited, OUTPUT_POLL_MS);
		follower.read();
	}

	follower.finish();
}

/**
 * Read a service's output until its tree is gone, then mark it stopped.
 *
 * @param session - Its status.
 * @param id - Which service: its entry in the status.
 * @param watch - The clock, the service's worker, its output reader, and
 *   what to do once it stopped.
 */
async function followServiceAsync(
	session: SessionSetup,
	id: ServiceInvocation["id"],
	{
		clock,
		follower,
		onStopped,
		worker,
	}: Pick<ServiceHooks, "onStopped"> & {
		clock: Clock;
		follower: OutputFollower;
		worker: SpawnedWorker;
	},
): Promise<void> {
	await followUntilExitAsync(clock, worker, follower);
	session.status.service(id, "stopped");
	onStopped?.();
}

/**
 * Start one service through the reaper. Its output goes line by line to its
 * rotated log and to `onLine`.
 *
 * @param session - The context and the session directory.
 * @param scope - Starts the service and tracks its output.
 * @param service - The resolved service.
 * @param hooks - Its status once it runs, what else gets each output line,
 *   and what to do once it stopped.
 */
async function startServiceAsync(
	session: SessionSetup,
	scope: SessionScope,
	service: ServiceInvocation,
	{ initial, onLine, onStopped }: ServiceHooks,
): Promise<void> {
	const { cwd, env, reporter, seams } = session.context;
	const { clock, fileSystem } = seams;
	const spoolDirectory = path.join(session.directory, "output");
	const spool = path.join(spoolDirectory, `${service.id}.log`);
	fileSystem.mkdirSync(spoolDirectory, { recursive: true });
	const log = openLogFile(fileSystem, logFilePath(cwd, service.id));
	const startedAt = new Date(clock.now());
	log.write(`--- forge start ${startedAt.toISOString()} ---`);

	const { step, ...invocation } = service;
	reporter.emit({ name: step, status: "started", type: "step" });
	const worker = await scope.startServiceAsync({ ...invocation, cwd, env, log: spool });
	if (worker === undefined) {
		return;
	}

	reporter.emit({ name: step, status: "succeeded", type: "step" });
	session.status.service(service.id, initial);
	const follower = followOutput(fileSystem, spool, (line) => {
		log.write(stripVTControlCharacters(line));
		onLine?.(line);
	});
	scope.track(followServiceAsync(session, service.id, { clock, follower, onStopped, worker }));
}

/**
 * Start Rojo, then the watch-mode compiler, if any. Rojo is ready once it
 * listens; a compiler that reports compiles, after its first one.
 *
 * @param session - The resolved services.
 * @param scope - Starts them.
 */
async function startServicesAsync(session: SessionSetup, scope: SessionScope): Promise<void> {
	await startServiceAsync(session, scope, session.rojo, { initial: "starting" });
	const { compiler } = session;
	if (compiler !== undefined) {
		const hooks: ServiceHooks = compiler.parsesDiagnostics
			? { ...compileReader(session), initial: "starting" }
			: { initial: "ready" };
		await startServiceAsync(session, scope, compiler.service, hooks);
	}
}

/**
 * The command context with a process runner that runs through the session's
 * reaper, so every step and hook is a worker.
 *
 * @param session - The context and the session directory.
 * @param scope - Its reaper and end signal.
 * @param name - The log and worker-id prefix, such as `start`.
 * @returns The context for the steps.
 */
function workerContext(
	{ context, directory }: SessionSetup,
	scope: SessionScope,
	name: string,
): CommandContext {
	const { clock, fileSystem } = context.seams;
	const processRunner = createReaperRunner({
		name,
		clock,
		fileSystem,
		log: openLogFile(fileSystem, logFilePath(context.cwd, name)),
		reaper: scope.reaper,
		signal: scope.signal,
		spoolDirectory: path.join(directory, "output"),
	});
	return { ...context, seams: { ...context.seams, processRunner } };
}

/**
 * The steps before the services: syncback check, compile, build, open.
 *
 * @param session - The config, plan, and context.
 * @param scope - Its reaper and end signal.
 * @param requireSyncback - The session's check of Rojo's syncback support.
 * @returns The place opened in Studio and the Studio forge started, or
 *   `undefined` when none was.
 * @rejects A step's failure. A step that the session's end
 *   stopped fails too; the session has its reason by then.
 */
async function runStepsAsync(
	session: SessionSetup,
	scope: SessionScope,
	requireSyncback: SyncbackCheck,
): Promise<OpenedStudio | undefined> {
	const { config, plan } = session;
	const steps = workerContext(session, scope, "start");
	if (plan.syncback) {
		await requireSyncback(steps);
	}

	// Steps run through the reaper runner, which starts nothing once the
	// session is ending.
	if (plan.compile) {
		await compileAsync(steps, config);
	}

	if (plan.build) {
		await buildAsync(steps, config, {
			project: config.rojoProjectPath,
			target: { output: config.buildOutputPath, type: "output" },
		});
	}

	// Studio starts outside the reaper, so this step checks by itself.
	if (!plan.open || scope.signal.aborted) {
		return undefined;
	}

	// The build above wrote the place `open` would build.
	const isBuilt =
		plan.build &&
		config.open.buildOutputPath === undefined &&
		config.open.projectPath === undefined;
	const { place, studio } = await openPlaceAsync(steps, config, { isBuilt });
	session.status.studio("opening", place, studio);
	return { place, process: studio };
}

function watchOptions(session: SessionSetup, scope: SessionScope): WatchOptions {
	const { clock, fileSystem } = session.context.seams;
	return { clock, fileSystem, intervalMs: FILE_POLL_MS, signal: scope.signal };
}

/**
 * Wait for syncback before a session whose Studio closed ends: look at the
 * place once more, then wait for the runs going, for at most
 * {@link STUDIO_CLOSED_SYNCBACK_MS}. A stop meanwhile ends the runs.
 *
 * @param clock - Runs the bound.
 * @param flushSyncbackAsync - Looks at the place and waits for the runs.
 */
async function settleSyncbackAsync(
	clock: Clock,
	flushSyncbackAsync: () => Promise<void>,
): Promise<void> {
	await settlesWithinAsync(clock, flushSyncbackAsync(), STUDIO_CLOSED_SYNCBACK_MS);
}

/**
 * End the session with `studio_closed` once Studio closes the place, after
 * the syncback of a save just before the close.
 *
 * @param session - The clock, file system, and reporter.
 * @param scope - Where the end goes.
 * @param studio - The place the session opened, its Studio, and the
 *   syncback flush.
 * @param studio.flushSyncbackAsync - Looks at the place and waits for the
 *   runs.
 * @param studio.place - The absolute path of the place file.
 * @param studio.process - The Studio forge started directly, if it did.
 */
async function watchStudioAsync(
	session: SessionSetup,
	scope: SessionScope,
	{
		flushSyncbackAsync,
		place,
		process,
	}: OpenedStudio & { flushSyncbackAsync: () => Promise<void> },
): Promise<void> {
	const { reporter } = session.context;
	const lockPath = studioLockPath(place);
	const isClosed = await waitForStudioCloseAsync(watchOptions(session, scope), lockPath, () => {
		session.status.studio("open", place, process);
		reporter.emit({
			message: `Roblox Studio has ${place} open. The session ends when Studio closes it.`,
			type: "info",
		});
	});
	// A watch that ended first ended with the session: Studio stays open.
	if (!isClosed) {
		return;
	}

	session.status.studio("closed", place, process);
	await settleSyncbackAsync(session.context.seams.clock, flushSyncbackAsync);
	scope.end({ type: "studio_closed" });
}

function hasEnded(scope: SessionScope): boolean {
	return scope.signal.aborted;
}

/**
 * Wait until Rojo listens on its port, so `ready` means a client can
 * connect, then mark it ready.
 *
 * @param session - The config, clock, network, and status.
 * @param scope - Its end signal.
 * @returns `true` once Rojo listens; `false` when the session ended first.
 * @rejects {ForgeError} `service_failed` when Rojo does not listen within
 *   {@link ROJO_LISTEN_BOUND_MS}.
 */
async function waitForRojoAsync(session: SessionSetup, scope: SessionScope): Promise<boolean> {
	const { config, context } = session;
	const { clock, network } = context.seams;
	const port = config.rojoPort;
	const deadline = clock.now() + ROJO_LISTEN_BOUND_MS;
	while (!hasEnded(scope)) {
		if (await network.isListeningAsync(port)) {
			// The session may have ended while the check ran.
			if (hasEnded(scope)) {
				return false;
			}

			session.status.service("rojo", "ready");
			return true;
		}

		if (clock.now() >= deadline) {
			throw new ForgeError(
				"service_failed",
				`rojo did not listen on port ${port} within ${ROJO_LISTEN_BOUND_MS / 1000} s, so the session stopped.`,
				{
					details: { reason: "service_failed:rojo" },
					hint: `Its output is in ${logFilePath(context.cwd, "rojo")}.`,
				},
			);
		}

		// The session's end ends the pause early.
		await settlesWithinAsync(clock, NEVER, ROJO_LISTEN_POLL_MS, scope.signal);
	}

	return false;
}

function announceReady({ config, context, plan }: SessionSetup): void {
	const services = plan.compiler === undefined ? "" : " The compiler watches your code.";
	context.reporter.emit({
		message: `Rojo serves ${config.rojoProjectPath} on port ${config.rojoPort}.${services} Press Ctrl+C to stop.`,
		type: "info",
	});
}
