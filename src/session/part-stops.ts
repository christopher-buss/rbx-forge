import { recoveryOptions } from "../client/studio.ts";
import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import type { AutoRecoveryMode } from "../config/schema.ts";
import { toForgeError } from "../errors.ts";
import type { IpcFailure } from "../ipc/protocol.ts";
import { settlesWithinAsync } from "../seams/clock.ts";
import type { StudioStop, StudioTarget } from "../studio/close-studio.ts";
import { closeStudioAsync, STUDIO_CLOSE_MS } from "../studio/close-studio.ts";
import type { StudioProcess } from "../studio/launcher.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import type { Ownership } from "./ownership.ts";
import type { SessionScope } from "./run-session.ts";
import type { ServiceParts } from "./service-parts.ts";
import type {
	PartId,
	PartOwner,
	ServiceId,
	SessionStatus,
	SessionStudio,
	StatusStore,
} from "./status.ts";
import type { StudioState } from "./studio-part.ts";

/**
 * Who asks to stop parts: `down` (every part), `stop` (Studio and its
 * Rojo), or `restart` (every part; the session never ends on it).
 */
export type StopScope = "down" | "restart" | "stop";

/** What one `stopParts` request asks for. */
export interface StopPartsRequest {
	/** Act on owned parts too (`stop --force`, `restart --force`). */
	readonly force: boolean;
	/** `down --keep-studio`: leave Studio open, and let the session go. */
	readonly keepStudio: boolean;
	/** The place whose Studio `stop` closes, absolute; any when unset. */
	readonly place?: string | undefined;
	/** What to do with the auto-recovery files of a Studio forge ends. */
	readonly recovery?: AutoRecoveryMode | undefined;
	readonly scope: StopScope;
}

/** A part a stop left running, because it has an owner. */
export interface KeptPart {
	owner: PartOwner;
	part: PartId;
}

/** What closing the session's Studio did, or why it failed. */
export type StudioOutcome =
	| { error: IpcFailure; place: string }
	| { place: string; stop: StudioStop };

/** What one stop did. */
export interface PartStops {
	/** The session ends: no part is left. */
	ending: boolean;
	kept: Array<KeptPart>;
	/** The parts it stopped, in order. */
	stopped: Array<PartId>;
	/** What it did with the session's Studio, when it tried to close one. */
	studio?: StudioOutcome;
}

/** Stops the parts a request may stop. */
export type PartStopper = (request: StopPartsRequest) => Promise<PartStops>;

/** Which parts a stop acts on, and which it leaves to their owner. */
export interface StopPlan {
	kept: Array<KeptPart>;
	stop: Array<PartId>;
}

/**
 * How long a stop waits for a session's Studio that is still `opening`:
 * launched (or about to be), with the place not open yet. Studio shows a
 * place 5 to 11 s after its start on a desktop; the rest covers a big
 * place, a slow disk, and a compile and build before the launch.
 */
export const STUDIO_OPEN_WAIT_MS = 60_000;

/** How often a stop looks at a Studio that is opening. */
const STUDIO_OPEN_POLL_MS = 250;

/**
 * How long a session whose Studio closed waits for syncback before it ends:
 * a save just before the close still syncs back.
 */
export const STUDIO_CLOSED_SYNCBACK_MS = 30_000;

/**
 * How long a client lets a session take to answer `stopParts`, besides the
 * grace of its services: a Studio that is opening, its close and kill, and
 * the syncback of a last save.
 */
export const STOP_PARTS_WAIT_MS: number =
	STUDIO_OPEN_WAIT_MS + 2 * STUDIO_CLOSE_MS + STUDIO_CLOSED_SYNCBACK_MS;

/** What the stopper runs with. */
export interface StopperSetup {
	config: Pick<ResolvedConfig, "studio">;
	/** The seams, environment, and project root. */
	context: CommandContext;
	status: Pick<StatusStore, "phase" | "snapshot" | "studio">;
}

/** The session state a stop changes. */
export interface StopperParts {
	/** Looks at the place once more and waits for the syncback runs. */
	flushSyncbackAsync: () => Promise<void>;
	/** A `start` holds the session: it ends on the owner's end only. */
	ownership: Pick<Ownership, "isOwned">;
	parts: Pick<ServiceParts, "isRunning" | "stopAsync">;
	state: StudioState;
}

/**
 * Whether a part runs, by the session's status: a service `starting` or
 * `ready`, a Studio `opening` or `open`.
 *
 * @param services - The parts' status.
 * @param part - Which of them.
 * @returns Whether it runs.
 */
export function isPartRunning(services: SessionStatus["services"], part: PartId): boolean {
	const { status } = services[part];
	return part === "studio"
		? status === "open" || status === "opening"
		: status === "ready" || status === "starting";
}

/**
 * Decide which running parts a request stops: those with no owner, and with
 * `force` the owned ones too. The rest it keeps, with their owner. Rojo
 * stops with its Studio in the `stop` scope, so it stays when Studio does.
 *
 * @param services - The parts' status and owners.
 * @param request - The scope, place, `force`, and `keepStudio`.
 * @returns What to stop, Studio first, and what to keep.
 */
export function planStops(
	services: SessionStatus["services"],
	request: StopPartsRequest,
): StopPlan {
	const plan: StopPlan = { kept: [], stop: [] };
	for (const part of partsInScope(services.studio, request)) {
		const { owner } = services[part];
		if (!isPartRunning(services, part)) {
			continue;
		}

		if (owner !== null && !request.force) {
			plan.kept.push({ owner, part });
		} else if (part !== "rojo" || request.scope !== "stop" || plan.stop.includes("studio")) {
			plan.stop.push(part);
		}
	}

	return plan;
}

/**
 * The Studio to close for a session's Studio: its place, and the Studio
 * forge started, if it did.
 *
 * @param studio - What the session reports.
 * @returns The target; `undefined` when the session has no Studio open or
 *   opening.
 */
export function sessionStudioTarget({
	pid,
	place,
	startTime,
	status,
}: SessionStudio): StudioTarget | undefined {
	if (place === undefined || (status !== "open" && status !== "opening")) {
		return undefined;
	}

	return {
		place,
		...(pid === undefined || startTime === undefined ? {} : { process: { pid, startTime } }),
	};
}

/**
 * Make the stopper of a session's parts, for `down`, `stop`, and later
 * `restart` and the idle timeout:
 *
 * 1. Decide from the status which running parts the request may stop
 *    ({@link planStops}), once a Studio in its scope is past `opening`.
 * 2. Close Studio (`closeStudioAsync`: a close request, then a kill, with
 *    its auto-recovery files handled), or let it go with `keepStudio`.
 * 3. Stop Rojo and the compiler, and wait until each tree is gone.
 * 4. End the session once no part is left, after the syncback of a save
 *    just before Studio closed.
 *
 * @param setup - The config, context, and status.
 * @param scope - Where the session's end goes.
 * @param stopper - The parts, the Studio state, and the syncback flush.
 * @returns The stopper the control channel calls.
 */
export function createPartStopper(
	setup: StopperSetup,
	scope: Pick<SessionScope, "end">,
	stopper: StopperParts,
): PartStopper {
	return async (request) => {
		const services = await servicesForAsync(setup, request);
		const { kept, stop } = planStops(services, request);
		const studio = stop.includes("studio")
			? await stopStudioAsync(setup, stopper, request, services)
			: undefined;
		if (request.keepStudio && request.scope === "down") {
			stopper.state.isAttached = false;
		}

		const isStudioGone = studio?.isGone === true;
		const serviceParts = await stopServicesAsync(stopper, request.scope, {
			isStudioGone,
			stop,
		});
		const stopped: Array<PartId> = isStudioGone ? ["studio", ...serviceParts] : serviceParts;
		const isEnding = await endIfEmptyAsync(setup, scope, stopper, {
			hasClosedStudio: isStudioGone,
			hasStopped: stopped.length > 0,
			scope: request.scope,
		});
		return {
			ending: isEnding,
			kept,
			stopped,
			...(studio?.outcome === undefined ? {} : { studio: studio.outcome }),
		};
	};
}

/**
 * The parts a scope reaches: `down` and `restart` every part, `stop` the
 * Studio of its place (any, when unset) with that Studio's Rojo.
 *
 * @param studio - The session's Studio.
 * @param request - The scope and place.
 * @returns The parts, Studio first.
 */
function partsInScope(
	studio: SessionStudio,
	{ keepStudio, place, scope }: StopPartsRequest,
): Array<PartId> {
	if (scope !== "stop") {
		return keepStudio && scope === "down"
			? ["rojo", "compiler"]
			: ["studio", "rojo", "compiler"];
	}

	return place === undefined || studio.place === place ? ["studio", "rojo"] : [];
}

/**
 * The session's parts once its Studio is past `opening`, or once
 * {@link STUDIO_OPEN_WAIT_MS} have passed.
 *
 * @param setup - The clock and status.
 * @returns The parts' status.
 */
async function settledServicesAsync(setup: StopperSetup): Promise<SessionStatus["services"]> {
	const { clock } = setup.context.seams;
	const deadline = clock.now() + STUDIO_OPEN_WAIT_MS;
	for (;;) {
		const { services } = setup.status.snapshot();
		if (services.studio.status !== "opening" || clock.now() >= deadline) {
			return services;
		}

		await clock.sleep(STUDIO_OPEN_POLL_MS);
	}
}

/**
 * The parts' status a request is planned on: once a Studio it may stop is
 * past `opening`.
 *
 * @param setup - The clock and status.
 * @param request - The scope, place, and `force`.
 * @returns The parts' status.
 */
async function servicesForAsync(
	setup: StopperSetup,
	request: StopPartsRequest,
): Promise<SessionStatus["services"]> {
	const { services } = setup.status.snapshot();
	return planStops(services, request).stop.includes("studio")
		? settledServicesAsync(setup)
		: services;
}

/**
 * Stop Rojo and the compiler as planned, and wait until each tree is gone.
 * In the `stop` scope, Rojo stops only with its Studio.
 *
 * @param stopper - Stops the parts.
 * @param scope - Who asks.
 * @param plan - The parts to stop, and whether their Studio is gone.
 * @param plan.isStudioGone - The request closed the session's Studio.
 * @param plan.stop - The parts the request may stop.
 * @returns The services it stopped, in order.
 */
async function stopServicesAsync(
	stopper: StopperParts,
	scope: StopScope,
	{ isStudioGone, stop }: { isStudioGone: boolean; stop: ReadonlyArray<PartId> },
): Promise<Array<ServiceId>> {
	const services = stop.filter((part): part is ServiceId => {
		return part === "compiler" || (part === "rojo" && (scope !== "stop" || isStudioGone));
	});
	for (const part of services) {
		await stopper.parts.stopAsync(part);
	}

	return services;
}

/**
 * Close the session's Studio. A failure is the outcome, not thrown.
 *
 * @param setup - The seams, environment, project, and recovery default.
 * @param studio - The Studio the session reports.
 * @param recovery - The request's recovery mode, over the config's.
 * @returns What closing it did; `undefined` when it has no place yet.
 */
async function closeSessionStudioAsync(
	setup: StopperSetup,
	studio: SessionStudio,
	recovery: AutoRecoveryMode | undefined,
): Promise<StudioOutcome | undefined> {
	const target = sessionStudioTarget(studio);
	if (target === undefined) {
		return undefined;
	}

	const { context } = setup;
	try {
		const stop = await closeStudioAsync(
			context.seams,
			target,
			recoveryOptions(context.env, forgeFiles(context.cwd), {
				studio: { autoRecovery: recovery ?? setup.config.studio.autoRecovery },
			}),
		);
		return { place: target.place, stop };
	} catch (err) {
		const { code, details, hint, message } = toForgeError(err);
		return {
			error: {
				code,
				...(details === undefined ? {} : { details }),
				...(hint === undefined ? {} : { hint }),
				message,
			},
			place: target.place,
		};
	}
}

/**
 * The Studio process the session recorded.
 *
 * @param studio - The Studio the session reports.
 * @returns Its PID and start time; `null` when it has none.
 */
function studioProcess({ pid, startTime }: SessionStudio): null | StudioProcess {
	return pid === undefined || startTime === undefined ? null : { pid, startTime };
}

/**
 * Close or let go of the session's Studio for a request.
 *
 * @param setup - The seams, environment, project, and recovery default.
 * @param stopper - The Studio state.
 * @param request - The scope, `keepStudio`, and recovery mode.
 * @param services - The parts' status.
 * @returns What closing it did, and whether Studio is gone from the
 *   session.
 */
async function stopStudioAsync(
	setup: StopperSetup,
	stopper: StopperParts,
	request: StopPartsRequest,
	services: SessionStatus["services"],
): Promise<{ isGone: boolean; outcome: StudioOutcome | undefined }> {
	const outcome = await closeSessionStudioAsync(setup, services.studio, request.recovery);
	const isGone = outcome !== undefined && "stop" in outcome;
	if (isGone) {
		// Its follow ends here: its late close would stop the next Studio's Rojo.
		stopper.state.letGo?.();
		stopper.state.letGo = undefined;
		// The answer and the state contract agree, before the close watch sees
		// it.
		setup.status.studio("closed", outcome.place, studioProcess(services.studio));
	}

	// `down` lets go of a Studio it could not close: the session still ends.
	if (isGone || request.scope === "down") {
		stopper.state.isAttached = false;
	}

	return { isGone, outcome };
}

/**
 * Whether the session may end: no `start` holds it, no service runs, and no
 * Studio is attached.
 *
 * @param stopper - The ownership, the parts, and the Studio state.
 * @returns `true` when nothing keeps it.
 */
function isEmpty({ ownership, parts, state }: StopperParts): boolean {
	return (
		!ownership.isOwned &&
		!parts.isRunning("compiler") &&
		!parts.isRunning("rojo") &&
		!state.isAttached
	);
}

/**
 * End a session that has no part left: `restart` never ends it, and `stop`
 * only once it stopped a part.
 *
 * @param setup - The status.
 * @param scope - Where the end goes.
 * @param stopper - The parts, the Studio state, and the syncback flush.
 * @param done - The request's scope, and whether it stopped a part and
 *   closed a Studio.
 * @returns Whether the session ends.
 */
async function endIfEmptyAsync(
	setup: StopperSetup,
	scope: Pick<SessionScope, "end">,
	stopper: StopperParts,
	done: { hasClosedStudio: boolean; hasStopped: boolean; scope: StopScope },
): Promise<boolean> {
	const isEnding =
		done.scope !== "restart" && (done.scope === "down" || done.hasStopped) && isEmpty(stopper);
	if (!isEnding) {
		return false;
	}

	if (done.hasClosedStudio) {
		await settlesWithinAsync(
			setup.context.seams.clock,
			stopper.flushSyncbackAsync(),
			STUDIO_CLOSED_SYNCBACK_MS,
		);
	}

	setup.status.phase("stopping");
	scope.end({ type: "shutdown" });
	return true;
}
