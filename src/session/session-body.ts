import { compileAsync } from "../commands/compile.ts";
import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import type { AdderSetup, CompilerService } from "./compiler-part.ts";
import { createPartAdder, startCompilerAsync } from "./compiler-part.ts";
import type { IdleTracker } from "./idle.ts";
import { stopWhenIdleAsync } from "./idle.ts";
import type { Ownership } from "./ownership.ts";
import { createOwnerHandlers } from "./ownership.ts";
import type { PartAdder, PartRequests } from "./part-requests.ts";
import { createPartRestarter } from "./part-restarts.ts";
import { createPartStopper, planStops } from "./part-stops.ts";
import type { SessionPlan } from "./plan.ts";
import { hasEnded, resolveRojoAsync, startRojoAsync, waitForRojoAsync } from "./rojo-part.ts";
import type { SessionScope } from "./run-session.ts";
import type { ServiceParts } from "./service-parts.ts";
import { createServiceParts } from "./service-parts.ts";
import type { SessionSync } from "./session-sync.ts";
import type { SyncbackCheck } from "./session-syncback.ts";
import { checkSyncbackOnce, startSyncback, watchSavesForSyncback } from "./session-syncback.ts";
import type { PartOwner, StatusRecorder, StatusStore } from "./status.ts";
import type { PreparedStudio, StudioSetup, StudioState } from "./studio-part.ts";
import {
	createStudioAdder,
	followSessionStudio,
	openStudioAsync,
	prepareStudioAsync,
} from "./studio-part.ts";
import type { SaveWatch } from "./watch.ts";
import { watchOptions, workerContext } from "./worker-context.ts";

/** Everything one dev session runs with. */
export interface SessionSetup extends AdderSetup, StudioSetup {
	builds: AdderSetup["builds"] & StudioSetup["builds"];
	/** The compiler service, when the plan starts one. */
	compiler: CompilerService | undefined;
	config: ResolvedConfig;
	/** `.forge/sessions/<id>`: raw worker output while the session runs. */
	directory: string;
	/** When the session is idle; its Studio's saves are activity. */
	idle: IdleTracker;
	/** The owner of the parts the session starts with: `start`, or none. */
	owner: null | PartOwner;
	/**
	 * Gets the session's part handlers, for `up`, `down`, `stop`, `start`,
	 * and queues the idle stop with the requests.
	 */
	parts: Pick<PartRequests, "attach" | "stopAsync">;
	plan: SessionPlan;
	/** Gets what the session does, for `status` and `state.json`. */
	status: Pick<StatusStore, "phase" | "snapshot"> & StatusRecorder;
	/** Gets the session's syncback runner, for `forge sync`. */
	sync: Pick<SessionSync, "attach" | "close">;
}

/** What the session body hands from one stage to the next. */
interface BodyState {
	/** Looks at the place once more and waits for the syncback runs. */
	flushSyncbackAsync: () => Promise<void>;
	/** The session's service parts. */
	parts: ServiceParts;
	/** The steps context: steps and hooks run as its workers. */
	steps: CommandContext;
	studio: StudioState;
}

/** Every part: what a `start` that started the session added. */
const ALL_PARTS = ["studio", "rojo", "compiler"] as const;

/**
 * The body of a dev session, for
 * `runSessionAsync`:
 *
 * 1. With syncback on, check that Rojo has syncback, before anything runs.
 * 2. Compile (roblox-ts) and build once, when the plan asks: a session with
 *    a compiler and Studio.
 * 3. Attach a verified Studio that already has the place open.
 * 4. Start Rojo and the watch-mode compiler, as the plan asks. Each is a
 *    service with its part: its exit stops only that part, which is then
 *    `failed`. From then on, `forge up` can add the parts that are missing
 *    or failed, and attach Studio with its Rojo (`studio-part.ts`); `down`
 *    and `stop` can stop the parts with no owner (`part-stops.ts`), and
 *    so does the idle timeout (`idle.ts`); `restart` stops them and starts
 *    them again (`part-restarts.ts`); a `start` can join as the
 *    owner, and its end stops what it started and gives back what it took
 *    (`ownership.ts`).
 * 5. Once Rojo listens, open a new Studio when none was attached and follow
 *    it: the close of an owned Studio stops nothing, of one with no owner
 *    only its Rojo. Expose part requests after this initial launch.
 * 6. Run syncback and its hooks for `forge sync` and, with syncback on,
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
		const steps = workerContext(session, scope, "start");
		const prepared = await runStepsAsync(session, { requireSyncback, steps });
		const syncing = startSyncbackRuns(session, scope, requireSyncback);
		const state: BodyState = {
			flushSyncbackAsync: syncing.flushSyncbackAsync,
			parts: createServiceParts(session, scope),
			steps,
			studio: { isAttached: false },
		};
		followPreparedStudio(session, scope, state, prepared);

		const served = await runServicesAsync(session, scope, state);
		if (served === undefined) {
			return;
		}

		const opening = await openPreparedStudioAsync(session, scope, state, {
			...served,
			prepared,
		});

		attachPartHandlers(session, scope, state);
		announceWhenReady(session, scope, served.port, opening);
		if (session.plan.syncback) {
			syncing.saves.check = watchSaves(session, scope, syncing.syncback);
		}
	};
}

/**
 * Follow an already-open Studio before starting its Rojo.
 *
 * @param session - The context and status.
 * @param scope - Its end signal and watches.
 * @param state - The Studio state and parts.
 * @param prepared - The prepared place, when requested.
 */
function followPreparedStudio(
	session: SessionSetup,
	scope: SessionScope,
	state: BodyState,
	prepared: PreparedStudio | undefined,
): void {
	if (prepared?.attached !== undefined) {
		followSessionStudio(session, scope, { ...state, state: state.studio }, prepared.attached);
	}
}

/**
 * Launch a new session Studio only while its Rojo listens.
 *
 * @param session - The config and context.
 * @param scope - The session's end signal and watches.
 * @param state - The Studio state and parts.
 * @param opening - The prepared place and listening port, when present.
 * @param opening.prepared - The place prepared before services started.
 * @param opening.port - The port on which Rojo listens, when it does.
 * @returns A managed launch's readiness wait, when one is required.
 */
async function openPreparedStudioAsync(
	session: SessionSetup,
	scope: SessionScope,
	state: BodyState,
	{ port, prepared }: { port: number | undefined; prepared: PreparedStudio | undefined },
): Promise<undefined | { open: Promise<void> }> {
	if (prepared === undefined || prepared.attached !== undefined) {
		return;
	}

	if (port !== undefined) {
		const opened = await openStudioAsync(
			session,
			state.steps,
			{ signal: scope.signal },
			prepared,
		);
		const following = followSessionStudio(
			session,
			scope,
			{ ...state, state: state.studio },
			opened,
		);
		if (opened.readiness !== undefined) {
			return following;
		}
	}

	if (!state.studio.isAttached) {
		session.status.studioLeft();
	}

	return undefined;
}

function noSaveWatch(): void {
	// No save watch runs: syncback runs only for `forge sync`.
}

/**
 * Start the session's syncback runner, with no save watch yet: it starts
 * once Rojo serves, and until then no save is seen.
 *
 * @param session - The config and context.
 * @param scope - Its reaper and end signal.
 * @param requireSyncback - Checks Rojo's syncback support.
 * @returns The runner, the save watch's look at the place, and the flush
 *   of a closing Studio.
 */
function startSyncbackRuns(
	session: SessionSetup,
	scope: SessionScope,
	requireSyncback: SyncbackCheck,
): {
	flushSyncbackAsync: () => Promise<void>;
	saves: Pick<SaveWatch, "check">;
	syncback: ReturnType<typeof startSyncback>;
} {
	const syncback = startSyncback(session, scope, {
		context: workerContext(session, scope, "syncback"),
		requireSyncback,
	});
	const saves: Pick<SaveWatch, "check"> = { check: noSaveWatch };
	return {
		flushSyncbackAsync: async () => {
			saves.check();
			await syncback.settled();
		},
		saves,
		syncback,
	};
}

/**
 * Run syncback on each place save, until the session ends.
 *
 * @param session - The config and context.
 * @param scope - Its end signal; tracks the watch.
 * @param syncback - Runs syncback.
 * @returns A look at the place now.
 */
function watchSaves(
	session: SessionSetup,
	scope: SessionScope,
	syncback: ReturnType<typeof startSyncback>,
): SaveWatch["check"] {
	const watch = watchSavesForSyncback(session, watchOptions(session.context, scope), syncback);
	// The watch ends with the session either way; tracking orders it.
	// Stryker disable next-line CallExpression: equivalent
	scope.track(watch.done);
	return watch.check;
}

/**
 * Start Rojo, then the watch-mode compiler, as the plan asks, and wait until
 * Rojo listens or stopped. Rojo is
 * ready once it listens; a compiler that reports compiles, after its first
 * one.
 *
 * @param session - The resolved services.
 * @param scope - Starts them; its end signal.
 * @param state - The steps context and the Studio state, for the adder.
 * @returns Rojo's port while it serves; `undefined` once the session is
 *   ending.
 * @rejects `port_in_use` or `rojo_missing` (resolved before, so neither
 *   comes), or as `ServiceParts.startAsync`.
 */
async function runServicesAsync(
	session: SessionSetup,
	scope: SessionScope,
	{ parts }: BodyState,
): Promise<undefined | { port: number | undefined }> {
	const rojo = session.plan.open
		? await startRojoAsync(session, scope, parts, await resolveRojoAsync(session))
		: undefined;
	if (session.compiler !== undefined) {
		await startCompilerAsync(session, parts, session.compiler);
	}

	const isServing = rojo !== undefined && (await waitForRojoAsync(session, scope, parts, rojo));
	if (hasEnded(scope)) {
		return undefined;
	}

	return { port: isServing ? rojo.port : undefined };
}

/**
 * The adder for `forge up`: the parts it starts have no owner, also a part
 * that failed while a `start` owned it.
 *
 * @param session - The status.
 * @param add - Starts the parts.
 * @returns The adder the control channel calls.
 */
function withNoOwner(session: SessionSetup, add: PartAdder): PartAdder {
	return async (request) => {
		const added = await add(request);
		for (const part of added) {
			session.status.owner(part, null);
		}

		return added;
	};
}

/**
 * Stop the parts with no owner each time the session is idle, through the
 * request queue, until the session ends.
 *
 * @param session - The config, context, idle tracker, and part requests.
 * @param scope - Its end signal; tracks the watch.
 */
function watchIdle({ config, context, idle, parts }: SessionSetup, scope: SessionScope): void {
	const setup = {
		clock: context.seams.clock,
		idle,
		minutes: config.session.idleTimeout,
		reporter: context.reporter,
		stopAsync: parts.stopAsync,
	};
	scope.track(stopWhenIdleAsync(setup, scope.signal));
}

/**
 * Expose part requests after the initial Studio launch, then mark startup done.
 *
 * @param session - The config and part requests.
 * @param scope - Its end signal and watches.
 * @param state - The services and Studio state.
 */
function attachPartHandlers(session: SessionSetup, scope: SessionScope, state: BodyState): void {
	const { parts } = state;

	const addStudio = createStudioAdder(session, scope, { ...state, state: state.studio });
	const add = createPartAdder(session, parts, addStudio);
	const ownership: Ownership = {
		added: new Set(session.owner === null ? [] : ALL_PARTS),
		isOwned: session.owner !== null,
	};
	const stop = createPartStopper(session, scope, { ...state, ownership, state: state.studio });
	session.parts.attach({
		add: withNoOwner(session, add),
		beforeStop: (request) => {
			const { services } = session.status.snapshot();
			if (
				planStops(services, request).stop.includes("studio") ||
				(request.scope === "down" && (services.studio.owner === null || request.force))
			) {
				state.studio.cancelReady?.();
			}
		},
		restart: createPartRestarter(session, { add, parts, stop }),
		stop,
		...createOwnerHandlers(session, scope, { add, ownership, parts, studio: state.studio }),
	});
	watchIdle(session, scope);
}

/**
 * The steps before the services: syncback check, compile, build.
 *
 * @param session - The config, plan, and context.
 * @param stages - The session's check of Rojo's syncback support, and the
 *   steps context.
 * @param stages.requireSyncback - Checks Rojo's syncback support.
 * @param stages.steps - Runs the steps and their hooks as workers.
 * @returns The prepared place, or `undefined` when none was requested.
 * @rejects A step's failure. A step that the session's end
 *   stopped fails too; the session has its reason by then.
 */
async function runStepsAsync(
	session: SessionSetup,
	{ requireSyncback, steps }: { requireSyncback: SyncbackCheck; steps: CommandContext },
): Promise<PreparedStudio | undefined> {
	const { config, plan } = session;
	if (plan.syncback) {
		await requireSyncback(steps);
	}

	// Steps run through the reaper runner, which starts nothing once the
	// session is ending.
	if (plan.compile) {
		await compileAsync(steps, config);
	}

	// A build runs only for the Studio it opens.
	return plan.open ? prepareStudioAsync(session, steps, { build: plan.build }) : undefined;
}

function announceReady({ config, context, plan }: SessionSetup, port: number | undefined): void {
	const rojo =
		port === undefined ? "" : `Rojo serves ${config.rojoProjectPath} on port ${port}. `;
	const compiler = plan.compiler === undefined ? "" : "The compiler watches your code. ";
	context.reporter.emit({
		message: `${rojo}${compiler}Press Ctrl+C to stop.`,
		type: "info",
	});
}

function announceWhenReady(
	session: SessionSetup,
	scope: SessionScope,
	port: number | undefined,
	opening: undefined | { open: Promise<void> },
): void {
	function ready(): void {
		session.status.started();
		announceReady(session, port);
	}

	if (opening === undefined) {
		ready();
		return;
	}

	function syncReady(): void {
		if (session.status.snapshot().services.studio.status === "open") {
			ready();
		}
	}

	scope.track(opening.open.then(syncReady));
}
