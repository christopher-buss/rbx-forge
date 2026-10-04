import assert from "node:assert/strict";

import { recoveryOptions } from "../client/studio.ts";
import type { CommandContext } from "../commands/context.ts";
import type { StudioDesktop } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import { settlesWithinAsync } from "../seams/clock.ts";
import { closeStudioAsync, findPlaceStudio } from "../studio/close-studio.ts";
import type { LocatedStudio, StudioProcess } from "../studio/launcher.ts";
import type { StudioSave } from "../studio/save-studio.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import type { SessionScope } from "./run-session.ts";
import type { ServiceParts } from "./service-parts.ts";
import { saveSessionStudioAsync } from "./session-save.ts";
import { openStudioAsync } from "./studio-launch.ts";
import type { StudioSetup, StudioState } from "./studio-part.ts";
import { followSessionStudio, STUDIO_OPEN_BOUND_MS } from "./studio-part.ts";

/** A serialized save and desktop move of the session Studio. */
export interface StudioMoveRequest {
	desktop: StudioDesktop;
	studioPath?: string | undefined;
	timeoutMs: number;
}
/** The actual desktop transition and the save that preceded it. */
export interface StudioMove {
	durationMs: number;
	from: StudioDesktop;
	pid: number;
	save: StudioSave;
	to: StudioDesktop;
}
/** The session's move use-case. */
export type StudioMover = (request: StudioMoveRequest) => Promise<StudioMove>;

interface MoveParts {
	parts: ServiceParts;
	state: StudioState;
	steps: CommandContext;
}

/**
 * Move Studio while retaining its Rojo and owner and the saved place bytes.
 * @param setup - The session config, status, activity, and launch identity.
 * @param scope - The session lifetime and tracked follows.
 * @param attach - The service parts, current follow, and worker context.
 * @returns The serialized move handler.
 */
export function createStudioMover(
	setup: StudioSetup,
	scope: SessionScope,
	attach: MoveParts,
): StudioMover {
	return async (request) => {
		const started = setup.context.seams.clock.now();
		try {
			const save = await saveSessionStudioAsync(setup, scope, request.timeoutMs);
			const process = await moveSavedAsync(setup, scope, attach, { request, save });
			return {
				durationMs: setup.context.seams.clock.now() - started,
				from: save.desktop,
				pid: process.pid,
				save,
				to: process.desktop,
			};
		} finally {
			setup.idle.activity(setup.context.seams.clock.now());
		}
	};
}

async function closePreviousAsync(
	setup: StudioSetup,
	scope: SessionScope,
	attach: MoveParts,
	{ place, previous }: { place: string; previous: StudioProcess },
): Promise<void> {
	const { origin } = setup.status.snapshot().services.studio;
	assert(origin !== undefined, "An open session Studio has an origin.");
	try {
		await closeStudioAsync(
			setup.context.seams,
			{ place, process: previous },
			recoveryOptions(setup.context.env, forgeFiles(setup.context.cwd), setup.config),
		);
	} catch (err) {
		followSessionStudio(setup, scope, attach, {
			origin,
			place,
			studio: previous,
		});
		throw err;
	}

	attach.state.isAttached = false;
	setup.status.studio("closed", place, previous);
}

async function reopenAsync(
	setup: StudioSetup,
	scope: SessionScope,
	attach: MoveParts,
	request: StudioMoveRequest & { place: string },
): Promise<LocatedStudio> {
	const launch = {
		...setup,
		config: { ...setup.config, open: { ...setup.config.open, buildOutputPath: request.place } },
	};
	const opened = await openStudioAsync(
		launch,
		attach.steps,
		{ desktop: request.desktop, signal: scope.signal, studioPath: request.studioPath },
		{ isBuilt: true },
	);
	const { open } = followSessionStudio(setup, scope, attach, opened);
	const isReady = await settlesWithinAsync(setup.context.seams.clock, open, STUDIO_OPEN_BOUND_MS);
	const actual = findPlaceStudio(setup.context.seams, request.place);
	if (
		!isReady ||
		actual === undefined ||
		setup.status.snapshot().services.studio.status !== "open"
	) {
		throw new ForgeError(
			"studio_launch_failed",
			"Studio did not reopen the saved place before the launch deadline.",
		);
	}

	setup.status.studio("open", request.place, actual, "forge");
	return actual;
}

async function moveSavedAsync(
	setup: StudioSetup,
	scope: SessionScope,
	attach: MoveParts,
	{ request, save }: { request: StudioMoveRequest; save: StudioSave },
): Promise<LocatedStudio> {
	const previous = findPlaceStudio(setup.context.seams, save.place);
	const recorded = setup.status.snapshot().services.studio;
	if (
		previous?.pid !== save.pid ||
		(recorded.startTime !== undefined && recorded.startTime !== previous.startTime)
	) {
		throw new ForgeError("studio_not_open", "The saved Studio is no longer open.");
	}

	if (save.desktop === request.desktop) {
		return previous;
	}

	const executable =
		request.studioPath ??
		setup.context.seams.native().pinProcess(save.pid)?.executablePath() ??
		undefined;
	attach.state.letGo?.();
	attach.state.cancelReady?.();
	await attach.state.followed;
	scope.signal.throwIfAborted();
	await closePreviousAsync(setup, scope, attach, { place: save.place, previous });
	return reopenAsync(setup, scope, attach, {
		...request,
		place: save.place,
		studioPath: executable,
	});
}
