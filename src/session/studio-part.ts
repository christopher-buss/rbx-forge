import path from "node:path";

import { buildAsync } from "../commands/build.ts";
import type { CommandContext } from "../commands/context.ts";
import { openPlaceAsync } from "../commands/open.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import { settlesWithinAsync } from "../seams/clock.ts";
import { studioLockPath } from "../studio/lock-file.ts";
import type { OpenedStudio } from "./attach.ts";
import { attachStudio } from "./attach.ts";
import type { BuildWatch } from "./build-watch.ts";
import { FRESH_BUILD_TIMEOUT_MS } from "./build-watch.ts";
import type { PartAdder, PartRequest } from "./part-requests.ts";
import type { RojoService, RojoSetup } from "./rojo-part.ts";
import { hasEnded, resolveRojoAsync, startRojoAsync, waitForRojoAsync } from "./rojo-part.ts";
import type { SessionScope } from "./run-session.ts";
import type { ServiceParts } from "./service-parts.ts";
import type { PartId, StatusRecorder } from "./status.ts";
import { waitForStudioCloseAsync } from "./watch.ts";
import { watchOptions } from "./worker-context.ts";

/**
 * How long an attach waits for Studio to open the place. Studio goes on
 * opening it after that, but `forge up` gets its answer.
 */
export const STUDIO_OPEN_BOUND_MS = 180_000;

/** Whether the session has a Studio: one that opens or has the place open. */
export interface StudioState {
	isAttached: boolean;
}

/** What opens and follows the session's Studio. */
export interface StudioSetup extends RojoSetup {
	/** Waits for the compiler's fresh build before the place is built. */
	builds: Pick<BuildWatch, "waitAsync">;
	config: ResolvedConfig;
	status: Pick<StatusRecorder, "rojoPort" | "service" | "studio">;
}

/** How the session opens Studio. */
interface OpenOptions {
	/** Build the session's place first, unless Studio has it open. */
	build: boolean;
	/** The session's end: once it came, no Studio opens. */
	signal: AbortSignal;
	/** The Studio executable to start, absolute. */
	studioPath?: string | undefined;
}

/** What an attach adds its parts with. */
interface AttachParts {
	parts: ServiceParts;
	state: StudioState;
	/** The session's steps context: builds and hooks run as its workers. */
	steps: CommandContext;
}

/**
 * Build the session's place with Rojo, as a step.
 *
 * @param steps - The steps context.
 * @param config - The project and the place.
 */
export async function buildPlaceAsync(
	steps: CommandContext,
	config: ResolvedConfig,
): Promise<void> {
	await buildAsync(steps, config, {
		project: config.rojoProjectPath,
		target: { output: config.buildOutputPath, type: "output" },
	});
}

/**
 * Open the place in Studio, or attach the verified Studio that has it open.
 * A place is never built under the Studio that has it open.
 *
 * @param setup - The config and context.
 * @param steps - The steps context.
 * @param options - Whether to build, the end signal, and the Studio path.
 * @returns The place and its Studio, or `undefined` once the session is
 *   ending.
 * @rejects A step's failure, as `openPlaceAsync`.
 */
export async function openStudioAsync(
	{ config, context }: Pick<StudioSetup, "config" | "context">,
	steps: CommandContext,
	{ build, signal, studioPath }: OpenOptions,
): Promise<OpenedStudio | undefined> {
	const attached = attachStudio(context, config);
	if (build && attached?.place !== path.resolve(context.cwd, config.buildOutputPath)) {
		await buildPlaceAsync(steps, config);
	}

	// Studio starts outside the reaper, so this step checks by itself.
	if (signal.aborted) {
		return undefined;
	}

	// The build above wrote the place `open` would build.
	const isBuilt =
		build && config.open.buildOutputPath === undefined && config.open.projectPath === undefined;
	return attached ?? (await openPlaceAsync(steps, config, { isBuilt, studioPath }));
}

/**
 * Follow the session's Studio until it closes the place: `open` once its
 * lock file names it. The caller marks it `closed`.
 *
 * @param setup - The context and status.
 * @param scope - Its end signal.
 * @param opened - The place and its Studio.
 * @param events - What happens once it is open, and what its close does.
 * @param events.onOpen - Called once it has the place open.
 * @param events.whenClosed - Says what its close does, such as that the
 *   session ends.
 * @returns `true` once Studio closed the place; `false` when the session
 *   ended first.
 */
export async function followStudioAsync(
	{ context, status }: Pick<StudioSetup, "context" | "status">,
	scope: Pick<SessionScope, "signal">,
	{ place, studio }: OpenedStudio,
	events: { onOpen?: () => void; whenClosed: string },
): Promise<boolean> {
	const lock = { path: studioLockPath(place), pid: studio?.pid };
	return waitForStudioCloseAsync(watchOptions(context, scope), lock, () => {
		status.studio("open", place, studio);
		context.reporter.emit({
			message: `Roblox Studio has ${place} open. ${events.whenClosed}`,
			type: "info",
		});
		events.onOpen?.();
	});
}

/**
 * Attach Studio and its Rojo to a running session, as `forge up --studio`
 * asks, and repair the Rojo of an attached Studio:
 *
 * 1. Choose Rojo's port (the session keeps it) and resolve Rojo, so a busy
 *    port or a missing Rojo fails before Studio opens.
 * 2. Wait for the compiler's fresh build, when it runs: the place build and
 *    Rojo read its output.
 * 3. Attach the Studio that has the place open, or build the place and open
 *    it. When Studio closes it, only its Rojo stops.
 * 4. Start Rojo, when it does not run, and wait until it listens.
 * 5. Wait until Studio has the place open.
 *
 * @param setup - The config, context, builds, Rojo, and status.
 * @param scope - Its end signal; tracks the Studio follow.
 * @param attach - The parts, the Studio state, and the steps context.
 * @returns The adder of the Studio half of a request.
 */
export function createStudioAdder(
	setup: StudioSetup,
	scope: SessionScope,
	attach: AttachParts,
): PartAdder {
	return async (request) => {
		const { hasWork, isStudioWanted } = planAttach(request, attach);
		if (!hasWork) {
			return [];
		}

		const rojo = await resolveRojoAsync(setup);
		const hasCompiler = attach.parts.isRunning("compiler");
		if (hasCompiler) {
			await setup.builds.waitAsync(FRESH_BUILD_TIMEOUT_MS);
		}

		const opening = isStudioWanted
			? await attachAsync(setup, scope, attach, {
					build: hasCompiler,
					studioPath: request.studioPath,
				})
			: undefined;
		const isRojoStarted = await serveRojoAsync(setup, scope, attach.parts, rojo);
		if (opening !== undefined && !hasEnded(scope)) {
			await waitForOpenAsync(setup, opening);
		}

		const added: Array<PartId> = opening === undefined ? [] : ["studio"];
		return isRojoStarted ? [...added, "rojo"] : added;
	};
}

/**
 * Follow an attached Studio: once it closes the place, only its Rojo stops.
 *
 * @param setup - The context and status.
 * @param scope - Its end signal.
 * @param attach - The parts and the Studio state.
 * @param opened - The place, its Studio, and what gets its open.
 */
async function followAttachedAsync(
	setup: StudioSetup,
	scope: SessionScope,
	{ parts, state }: Pick<AttachParts, "parts" | "state">,
	opened: OpenedStudio & { onOpen: () => void },
): Promise<void> {
	const isClosed = await followStudioAsync(setup, scope, opened, {
		onOpen: opened.onOpen,
		whenClosed: "Its Rojo stops when Studio closes it.",
	});
	opened.onOpen();
	if (!isClosed) {
		return;
	}

	state.isAttached = false;
	setup.status.studio("closed", opened.place, opened.studio);
	parts.stop("rojo");
}

/**
 * Open or attach Studio for an attach request, and follow it.
 *
 * @param setup - The config, context, and status.
 * @param scope - Its end signal; tracks the follow.
 * @param attach - The parts, the Studio state, and the steps context.
 * @param options - Whether to build, and the Studio path.
 * @returns The place and whether Studio has it open yet, or `undefined`
 *   once the session is ending.
 */
async function attachAsync(
	setup: StudioSetup,
	scope: SessionScope,
	attach: AttachParts,
	options: Pick<OpenOptions, "build" | "studioPath">,
): Promise<undefined | { open: Promise<void>; place: string }> {
	const opened = await openStudioAsync(setup, attach.steps, { ...options, signal: scope.signal });
	if (opened === undefined) {
		return undefined;
	}

	attach.state.isAttached = true;
	setup.status.studio("opening", opened.place, opened.studio);
	const open = Promise.withResolvers<void>();
	scope.track(followAttachedAsync(setup, scope, attach, { ...opened, onOpen: open.resolve }));
	return { open: open.promise, place: opened.place };
}

/**
 * Wait until Studio has the place open, for at most
 * {@link STUDIO_OPEN_BOUND_MS}. The session's end ends the wait.
 *
 * @param setup - The clock.
 * @param opening - The place, and whether Studio has it open.
 * @param opening.open - Resolves once it has, or the follow ended.
 * @param opening.place - The place file Studio opens.
 * @rejects {ForgeError} `studio_launch_failed` once the bound passed.
 */
async function waitForOpenAsync(
	setup: Pick<StudioSetup, "context">,
	{ open, place }: { open: Promise<void>; place: string },
): Promise<void> {
	if (await settlesWithinAsync(setup.context.seams.clock, open, STUDIO_OPEN_BOUND_MS)) {
		return;
	}

	throw new ForgeError(
		"studio_launch_failed",
		`Roblox Studio did not open ${place} within ${STUDIO_OPEN_BOUND_MS / 1000} s.`,
		{ hint: 'The session keeps waiting for it; check "forge status".' },
	);
}

/**
 * Whether an attach request has anything to do: Studio when it asks for it
 * and none is attached, Rojo when a Studio is attached and Rojo does not
 * run.
 *
 * @param request - The parts it asks for.
 * @param attach - The parts and the Studio state.
 * @returns Whether it adds Studio, and whether it adds anything.
 */
function planAttach(
	request: PartRequest,
	{ parts, state }: Pick<AttachParts, "parts" | "state">,
): { hasWork: boolean; isStudioWanted: boolean } {
	const isStudioWanted = request.parts.includes("studio") && !state.isAttached;
	return {
		hasWork: isStudioWanted || (state.isAttached && !parts.isRunning("rojo")),
		isStudioWanted,
	};
}

/**
 * Start Rojo when it does not run, and wait until it listens.
 *
 * @param setup - The context and status.
 * @param scope - Its end signal.
 * @param parts - Starts and stops Rojo.
 * @param rojo - Rojo on the session's port.
 * @returns Whether it started Rojo.
 */
async function serveRojoAsync(
	setup: StudioSetup,
	scope: SessionScope,
	parts: ServiceParts,
	rojo: RojoService,
): Promise<boolean> {
	const running = parts.isRunning("rojo") ? undefined : await startRojoAsync(setup, parts, rojo);
	if (running === undefined) {
		return false;
	}

	await waitForRojoAsync(setup, scope, parts, running);
	return true;
}
