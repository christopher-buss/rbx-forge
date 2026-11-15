import type { StudioDesktop } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import type { PinnedStudio } from "../seams/studio-host.ts";
import { findPlaceStudioAsync } from "../studio/close-studio.ts";
import type { LocatedStudio } from "../studio/launcher.ts";
import type { SessionScope } from "./run-session.ts";
import type { StudioSetup } from "./studio-part.ts";

/** A serialized visibility change of the session Studio. */
export interface StudioMoveRequest {
	desktop: StudioDesktop;
}
/** The visibility transition of the same Studio process. */
export interface StudioMove {
	durationMs: number;
	from: StudioDesktop;
	pid: number;
	to: StudioDesktop;
}
/** The session's move use-case. */
export type StudioMover = (request: StudioMoveRequest) => Promise<StudioMove>;

/**
 * Change Studio visibility while retaining its process, Rojo, and owner.
 * @param setup - The session status, activity, and native seams.
 * @param scope - The session lifetime.
 * @returns The serialized move handler.
 */
export function createStudioMover(setup: StudioSetup, scope: SessionScope): StudioMover {
	return async (request) => {
		const { seams } = setup.context;
		const started = seams.clock.now();
		return Promise.resolve().then(async () => {
			try {
				scope.signal.throwIfAborted();
				const { pinned, place, previous } = await sessionStudioAsync(setup);
				scope.signal.throwIfAborted();
				const from =
					(await seams.studioHost.platformAsync()) === "darwin"
						? await changeMacVisibilityAsync(pinned, request.desktop)
						: await changeWindowVisibilityAsync(pinned, request.desktop);
				setup.status.studio("open", place, {
					...previous,
					desktop: request.desktop,
				});
				return {
					durationMs: seams.clock.now() - started,
					from,
					pid: previous.pid,
					to: request.desktop,
				};
			} finally {
				setup.idle.activity(seams.clock.now());
			}
		});
	};
}

async function sessionStudioAsync(setup: StudioSetup): Promise<{
	pinned: PinnedStudio;
	place: string;
	previous: LocatedStudio;
}> {
	const { phase, services } = setup.status.snapshot();
	if (phase === "stopped" || phase === "stopping") {
		throw new ForgeError("not_running", "The session is stopping.");
	}

	const recorded = services.studio;
	if (recorded.status !== "open" || recorded.place === undefined) {
		throw new ForgeError("studio_not_open", "No session Studio is open.");
	}

	const { seams } = setup.context;
	const previous = await findPlaceStudioAsync(seams, recorded.place);
	const pinned =
		previous === undefined ? null : await seams.studioHost.pinProcessAsync(previous.pid);
	if (
		previous === undefined ||
		pinned === null ||
		previous.pid !== recorded.pid ||
		pinned.startTime !== previous.startTime ||
		(recorded.startTime !== undefined && recorded.startTime !== previous.startTime)
	) {
		throw new ForgeError("studio_not_open", "No session Studio is open.");
	}

	return { pinned, place: recorded.place, previous };
}

async function changeMacVisibilityAsync(
	pinned: PinnedStudio,
	desktop: StudioDesktop,
): Promise<StudioDesktop> {
	const isHidden = await pinned.appHiddenAsync();
	if (isHidden === null) {
		throw new ForgeError("studio_not_open", "The Studio app is no longer open.");
	}

	const from = isHidden ? "hidden" : "user";
	if (from !== desktop) {
		if (!(await pinned.setAppHiddenAsync(desktop === "hidden"))) {
			throw new ForgeError(
				"studio_launch_failed",
				"Studio could not change its app visibility.",
			);
		}

		// An unhidden Studio launched hidden has no window on screen until
		// active.
		if (desktop === "user") {
			await pinned.activateAppAsync();
		}
	}

	return from;
}

async function changeWindowVisibilityAsync(
	pinned: PinnedStudio,
	desktop: StudioDesktop,
): Promise<StudioDesktop> {
	const from = await pinned.windowVisibilityAsync();
	if (from === null) {
		throw new ForgeError("studio_not_open", "The Studio windows are no longer open.");
	}

	if (
		from !== desktop &&
		!(await pinned.setWindowVisibilityAsync(desktop === "hidden" ? "hidden" : "active"))
	) {
		throw new ForgeError(
			"studio_launch_failed",
			"Studio could not change its window visibility.",
		);
	}

	if (desktop === "hidden" && !(await pinned.startWindowHidingAsync())) {
		throw new ForgeError(
			"studio_launch_failed",
			"Studio could not start its window hiding watcher.",
		);
	}

	return from;
}
