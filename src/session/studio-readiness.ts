import type { CommandContext } from "../commands/context.ts";
import { settlesWithinAsync } from "../seams/clock.ts";
import type { StudioReadyListener } from "../seams/network.ts";
import type { OpenedStudio } from "./attach.ts";
import type { SessionScope } from "./run-session.ts";
import type { StatusRecorder } from "./status.ts";
import type { StudioState } from "./studio-part.ts";

/** Bound for both the place lock and completed initial synchronization. */
export const STUDIO_OPEN_BOUND_MS = 180_000;

interface ReadySetup {
	context: CommandContext;
	status: Pick<StatusRecorder, "studio">;
}

/**
 * Combine the place lock and a managed launch's sync acknowledgement.
 *
 * @param setup - The clock, reporter, and status.
 * @param scope - Ends and tracks the wait.
 * @param state - Cancels readiness before a permitted stop is queued.
 * @param opened - The launched place and its temporary callback.
 * @returns The lock callback, completion promise, and follow-end callback.
 */
export function createStudioReadiness(
	setup: ReadySetup,
	scope: Pick<SessionScope, "signal" | "track">,
	state: StudioState,
	opened: OpenedStudio & { readiness?: StudioReadyListener },
): { end: () => void; onLock: () => void; open: Promise<void> } {
	const open = Promise.withResolvers<void>();
	const lock = Promise.withResolvers<void>();
	const cancel = new AbortController();
	state.waitsForSync = opened.readiness !== undefined;
	state.cancelReady = () => {
		cancel.abort();
	};

	function markOpen(): void {
		recordStudioOpen(setup, opened);
	}

	function end(): void {
		cancel.abort();
		open.resolve();
	}

	function onLock(): void {
		lock.resolve();
		if (opened.readiness === undefined) {
			markOpen();
			open.resolve();
		}
	}

	if (opened.readiness !== undefined) {
		const signal = AbortSignal.any([scope.signal, cancel.signal]);
		const wait = { listener: opened.readiness, lock: lock.promise, markOpen, signal };
		scope.track(waitForReadyAsync(setup, wait).finally(open.resolve));
	}

	return { end, onLock, open: open.promise };
}

/**
 * Record readiness once the launch's required milestones are complete.
 *
 * @param setup - The status and reporter.
 * @param opened - The Studio and place.
 */
function recordStudioOpen(setup: ReadySetup, opened: OpenedStudio): void {
	setup.status.studio("open", opened.place, opened.studio);
	setup.context.reporter.emit({
		message: `Roblox Studio has ${opened.place} open.`,
		type: "info",
	});
}

/**
 * Keep the callback bounded, including while the place lock is absent.
 *
 * @param setup - The clock and reporter.
 * @param wait - The callback, lock, readiness recorder, and cancellation.
 */
async function waitForReadyAsync(
	{ context }: ReadySetup,
	{
		listener,
		lock,
		markOpen,
		signal,
	}: {
		listener: StudioReadyListener;
		lock: Promise<void>;
		markOpen: () => void;
		signal: AbortSignal;
	},
): Promise<void> {
	const wait = Promise.all([listener.ready, lock]);
	try {
		const hasCompleted = await settlesWithinAsync(
			context.seams.clock,
			wait,
			STUDIO_OPEN_BOUND_MS,
			signal,
		);
		if (signal.aborted) {
			return;
		}

		if (hasCompleted) {
			const [isAcknowledged] = await wait;
			if (isAcknowledged) {
				markOpen();
				return;
			}
		}

		context.reporter.emit({
			message:
				"Studio did not acknowledge its initial Rojo synchronization before the readiness deadline.",
			type: "warning",
		});
	} finally {
		listener.close();
	}
}
