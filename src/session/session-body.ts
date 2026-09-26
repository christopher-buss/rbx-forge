import path from "node:path";

import { buildAsync } from "../commands/build.ts";
import { compileAsync } from "../commands/compile.ts";
import type { CommandContext } from "../commands/context.ts";
import { openPlaceAsync } from "../commands/open.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import { logFilePath, openLogFile } from "../output/log-file.ts";
import type { Clock } from "../seams/clock.ts";
import { settlesWithinAsync } from "../seams/clock.ts";
import type { StudioProcess } from "../studio/launcher.ts";
import { studioLockPath } from "../studio/lock-file.ts";
import type { BuildWatch } from "./build-watch.ts";
import type { SessionPlan } from "./plan.ts";
import { createReaperRunner } from "./reaper-runner.ts";
import type { SessionScope } from "./run-session.ts";
import type {
	RunningPart,
	ServiceHooks,
	ServiceInvocation,
	ServiceParts,
} from "./service-parts.ts";
import { createServiceParts } from "./service-parts.ts";
import type { SessionSync } from "./session-sync.ts";
import type { SyncbackCheck } from "./session-syncback.ts";
import { checkSyncbackOnce, startSyncback, watchSavesForSyncback } from "./session-syncback.ts";
import type { StatusRecorder } from "./status.ts";
import type { SaveWatch, WatchOptions } from "./watch.ts";
import { waitForStudioCloseAsync } from "./watch.ts";

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

/** The place the session opened, and the Studio it started. */
interface OpenedStudio {
	place: string;
	process: null | StudioProcess;
}

/** How often the session looks at the place and Studio's lock file. */
export const FILE_POLL_MS = 500;

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
 * 4. Start Rojo and the watch-mode compiler. Each is a service with its
 *    part: its exit stops only that part, which is then `failed`.
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

		const parts = createServiceParts(session, scope);
		const rojo = await startServicesAsync(session, parts);
		const isServing = await waitForRojoAsync(session, scope, { parts, rojo });
		// A stop request while the services started: the session is ending.
		if (hasEnded(scope)) {
			return;
		}

		announceReady(session, isServing);
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
 * Start Rojo, then the watch-mode compiler, if any. Rojo is ready once it
 * listens; a compiler that reports compiles, after its first one.
 *
 * @param session - The resolved services.
 * @param parts - Starts them.
 * @returns Rojo's part, or `undefined` when the session is ending.
 */
async function startServicesAsync(
	session: SessionSetup,
	parts: ServiceParts,
): Promise<RunningPart | undefined> {
	const rojo = await parts.startAsync(session.rojo, { initial: "starting" });
	const { compiler } = session;
	if (compiler !== undefined) {
		const hooks: ServiceHooks = compiler.parsesDiagnostics
			? { ...compileReader(session), initial: "starting" }
			: { initial: "ready" };
		await parts.startAsync(compiler.service, hooks);
	}

	return rojo;
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
 * Follow whether a part still runs.
 *
 * @param scope - Tracks the watch.
 * @param stopped - Resolves once the part stopped.
 * @returns Whether the part still runs.
 */
function watchRunning(scope: SessionScope, stopped: Promise<void>): () => boolean {
	let isRunning = true;
	async function markAsync(): Promise<void> {
		await stopped;
		isRunning = false;
	}

	scope.track(markAsync());
	return () => isRunning;
}

/**
 * Wait until Rojo listens on its port, so `ready` means a client can
 * connect, then mark it ready. When it does not listen within
 * {@link ROJO_LISTEN_BOUND_MS}, stop it as `failed`.
 *
 * @param session - The config, clock, network, and status.
 * @param scope - Its end signal.
 * @param rojo - The service parts, and Rojo's part.
 * @param rojo.parts - Stops Rojo when it does not listen.
 * @param rojo.rojo - Rojo's part; `undefined` when the session is ending.
 * @returns `true` once Rojo listens; `false` when it stopped or the
 *   session ended first.
 */
async function waitForRojoAsync(
	session: SessionSetup,
	scope: SessionScope,
	{ parts, rojo }: { parts: ServiceParts; rojo: RunningPart | undefined },
): Promise<boolean> {
	if (rojo === undefined) {
		return false;
	}

	const { config, context } = session;
	const { clock, network } = context.seams;
	const port = config.rojoPort;
	const deadline = clock.now() + ROJO_LISTEN_BOUND_MS;
	const { stopped } = rojo;
	const isRunning = watchRunning(scope, stopped);
	while (!hasEnded(scope) && isRunning()) {
		if (await network.isListeningAsync(port)) {
			// The session may have ended, or Rojo stopped, while the check ran.
			if (hasEnded(scope) || !isRunning()) {
				return false;
			}

			session.status.service("rojo", "ready");
			return true;
		}

		if (clock.now() >= deadline) {
			parts.stop(
				"rojo",
				`rojo did not listen on port ${port} within ${ROJO_LISTEN_BOUND_MS / 1000} s`,
			);
			return false;
		}

		// Rojo's stop or the session's end ends the pause early.
		await settlesWithinAsync(clock, stopped, ROJO_LISTEN_POLL_MS, scope.signal);
	}

	return false;
}

function announceReady({ config, context, plan }: SessionSetup, isServing: boolean): void {
	const rojo = isServing
		? `Rojo serves ${config.rojoProjectPath} on port ${config.rojoPort}. `
		: "";
	const compiler = plan.compiler === undefined ? "" : "The compiler watches your code. ";
	context.reporter.emit({
		message: `${rojo}${compiler}Press Ctrl+C to stop.`,
		type: "info",
	});
}
