import { compileAsync } from "../commands/compile.ts";
import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import type { Clock } from "../seams/clock.ts";
import { settlesWithinAsync } from "../seams/clock.ts";
import type { OpenedStudio } from "./attach.ts";
import type { AdderSetup, CompilerService } from "./compiler-part.ts";
import { createPartAdder, startCompilerAsync } from "./compiler-part.ts";
import type { PartRequests } from "./part-requests.ts";
import type { SessionPlan } from "./plan.ts";
import { hasEnded, resolveRojoAsync, startRojoAsync, waitForRojoAsync } from "./rojo-part.ts";
import type { SessionScope } from "./run-session.ts";
import { createServiceParts } from "./service-parts.ts";
import type { SessionSync } from "./session-sync.ts";
import type { SyncbackCheck } from "./session-syncback.ts";
import { checkSyncbackOnce, startSyncback, watchSavesForSyncback } from "./session-syncback.ts";
import type { StatusRecorder, StatusStore } from "./status.ts";
import type { StudioSetup, StudioState } from "./studio-part.ts";
import {
	buildPlaceAsync,
	createStudioAdder,
	followStudioAsync,
	openStudioAsync,
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
	/** Gets the session's part adder, for `forge up`. */
	parts: Pick<PartRequests, "attach">;
	plan: SessionPlan;
	/** Gets what the session does, for `status` and `state.json`. */
	status: Pick<StatusStore, "phase"> & StatusRecorder;
	/** Gets the session's syncback runner, for `forge sync`. */
	sync: Pick<SessionSync, "attach" | "close">;
}

/**
 * How long a session whose Studio closed waits for syncback before it ends:
 * a save just before the close still syncs back.
 */
export const STUDIO_CLOSED_SYNCBACK_MS = 30_000;

/** What the session body hands from one stage to the next. */
interface BodyState {
	/** The steps context: steps and hooks run as its workers. */
	steps: CommandContext;
	studio: StudioState;
}

/**
 * The body of a dev session, for
 * `runSessionAsync`:
 *
 * 1. With syncback on, check that Rojo has syncback, before anything runs.
 * 2. Compile (roblox-ts) and build once, when the plan asks: a session with
 *    a compiler and Rojo or Studio.
 * 3. Open the place in Studio (or attach a verified Studio that has it
 *    open), and end the session when Studio closes it, once a save just
 *    before the close has synced back.
 * 4. Start Rojo and the watch-mode compiler, as the plan asks. Each is a
 *    service with its part: its exit stops only that part, which is then
 *    `failed`. From then on, `forge up` can add the parts that are missing
 *    or failed, and attach Studio with its Rojo (`studio-part.ts`).
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
		const steps = workerContext(session, scope, "start");
		const opened = await runStepsAsync(session, scope, { requireSyncback, steps });
		const state: BodyState = { steps, studio: { isAttached: opened !== undefined } };
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

		const served = await runServicesAsync(session, scope, state);
		if (served === undefined) {
			return;
		}

		announceReady(session, served.port);
		if (session.plan.syncback) {
			saves.check = watchSaves(session, scope, syncback);
		}
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

function noSaveWatch(): void {
	// No save watch runs: syncback runs only for `forge sync`.
}

/**
 * Start Rojo, then the watch-mode compiler, as the plan asks, hand the part
 * adder over, and wait until Rojo listens or stopped. Rojo is ready once it
 * listens; a compiler that reports compiles, after its first one.
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
	state: BodyState,
): Promise<undefined | { port: number | undefined }> {
	const parts = createServiceParts(session, scope);
	const rojo = session.plan.rojo
		? await startRojoAsync(session, parts, await resolveRojoAsync(session))
		: undefined;
	if (session.compiler !== undefined) {
		await startCompilerAsync(session, parts, session.compiler);
	}

	const addStudio = createStudioAdder(session, scope, { ...state, parts, state: state.studio });
	session.parts.attach(createPartAdder(session, parts, addStudio));
	session.status.started();
	const isServing = rojo !== undefined && (await waitForRojoAsync(session, scope, parts, rojo));
	if (hasEnded(scope)) {
		return undefined;
	}

	return { port: isServing ? rojo.port : undefined };
}

/**
 * The steps before the services: syncback check, compile, build, open.
 *
 * @param session - The config, plan, and context.
 * @param scope - Its reaper and end signal.
 * @param stages - The session's check of Rojo's syncback support, and the
 *   steps context.
 * @param stages.requireSyncback - Checks Rojo's syncback support.
 * @param stages.steps - Runs the steps and their hooks as workers.
 * @returns The place opened in Studio and the Studio forge started or
 *   attached, or `undefined` when none was.
 * @rejects A step's failure. A step that the session's end
 *   stopped fails too; the session has its reason by then.
 */
async function runStepsAsync(
	session: SessionSetup,
	scope: SessionScope,
	{ requireSyncback, steps }: { requireSyncback: SyncbackCheck; steps: CommandContext },
): Promise<OpenedStudio | undefined> {
	const { config, plan } = session;
	if (plan.syncback) {
		await requireSyncback(steps);
	}

	// Steps run through the reaper runner, which starts nothing once the
	// session is ending.
	if (plan.compile) {
		await compileAsync(steps, config);
	}

	if (plan.open) {
		return openStudioAsync(session, steps, { build: plan.build, signal: scope.signal });
	}

	if (plan.build) {
		await buildPlaceAsync(steps, config);
	}

	return undefined;
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
 * Follow the session's own Studio from `opening` on, and end the session
 * with `studio_closed` once Studio closes the place, after the syncback of a
 * save just before the close.
 *
 * @param session - The clock, file system, and reporter.
 * @param scope - Where the end goes.
 * @param opened - The place the session opened, its Studio, and the
 *   syncback flush.
 * @param opened.flushSyncbackAsync - Looks at the place and waits for the
 *   runs.
 */
async function watchStudioAsync(
	session: SessionSetup,
	scope: SessionScope,
	opened: OpenedStudio & { flushSyncbackAsync: () => Promise<void> },
): Promise<void> {
	session.status.studio("opening", opened.place, opened.studio);
	const isClosed = await followStudioAsync(session, scope, opened, {
		whenClosed: "The session ends when Studio closes it.",
	});
	// A watch that ended first ended with the session: Studio stays open.
	if (!isClosed) {
		return;
	}

	// Stopping before closed: `down` tells this session from one that goes
	// on without its Studio.
	session.status.phase("stopping");
	session.status.studio("closed", opened.place, opened.studio);
	await settleSyncbackAsync(session.context.seams.clock, opened.flushSyncbackAsync);
	scope.end({ type: "studio_closed" });
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
