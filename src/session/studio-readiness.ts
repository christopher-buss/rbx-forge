import type { CommandContext } from "../commands/context.ts";
import { settlesWithinAsync } from "../seams/clock.ts";
import type { StudioReadyListener } from "../seams/network.ts";
import type { StudioProcess } from "../studio/launcher.ts";
import { KEEP_HIDDEN_START_BOUND_MS, waitForWindowHidingAsync } from "../studio/window-hiding.ts";
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

	const signal = AbortSignal.any([scope.signal, cancel.signal]);
	const hiding = hideWindows(setup.context, opened, signal);

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
			openAfterLock(scope, { hiding, markOpen, open: open.resolve, signal });
		}
	}

	if (opened.readiness !== undefined) {
		const milestones = Promise.all([lock.promise, hiding]);
		const wait = { listener: opened.readiness, lock: milestones, markOpen, signal };
		scope.track(waitForReadyAsync(setup, wait).finally(open.resolve));
	}

	return { end, onLock, open: open.promise };
}

async function markOpenOnceHiddenAsync(
	hiding: Promise<void>,
	signal: AbortSignal,
	markOpen: () => void,
): Promise<void> {
	await hiding;
	if (!signal.aborted) {
		markOpen();
	}
}

/**
 * Record a Studio with no sync acknowledgement open once it has the place
 * open and, when the watcher hides its windows, the watcher runs.
 *
 * @param scope - Tracks the wait for the watcher.
 * @param lock - The watcher wait, the recorder, and what ends the wait.
 */
function openAfterLock(
	scope: Pick<SessionScope, "track">,
	{
		hiding,
		markOpen,
		open,
		signal,
	}: {
		hiding: Promise<void> | undefined;
		markOpen: () => void;
		open: () => void;
		signal: AbortSignal;
	},
): void {
	if (hiding === undefined) {
		markOpen();
		open();
		return;
	}

	scope.track(markOpenOnceHiddenAsync(hiding, signal, markOpen).finally(open));
}

/**
 * Wait until the watcher hides Studio's windows; warn when it does not start.
 *
 * @param context - The addon, clock, and reporter.
 * @param studio - The launched Studio.
 * @param signal - Ends the wait.
 */
async function waitForHiddenWindowsAsync(
	context: CommandContext,
	studio: StudioProcess,
	signal: AbortSignal,
): Promise<void> {
	const pinned = context.seams.native().pinProcess(studio.pid);
	// Only a Studio on the user's desktop has its windows hidden by the watcher.
	if (
		pinned?.startTime !== studio.startTime ||
		pinned.desktop() !== "user" ||
		(await waitForWindowHidingAsync(pinned, context.seams.clock, signal))
	) {
		return;
	}

	context.reporter.emit({
		message: `Studio may show its windows: the watcher that keeps them hidden did not start within ${KEEP_HIDDEN_START_BOUND_MS / 1000} s.`,
		type: "warning",
	});
}

/**
 * Wait for the detached watcher when forge launched this Studio hidden on
 * Windows, where a Studio on the user's desktop keeps its windows hidden
 * through that watcher.
 *
 * @param context - The host platform, addon, clock, and reporter.
 * @param opened - The Studio and where it came from.
 * @param signal - Ends the wait.
 * @returns The wait; `undefined` when `open` waits for no watcher.
 */
function hideWindows(
	context: CommandContext,
	{ origin, studio }: OpenedStudio,
	signal: AbortSignal,
): Promise<void> | undefined {
	return origin === "forge" &&
		context.seams.host.platform === "win32" &&
		studio?.desktop === "hidden"
		? waitForHiddenWindowsAsync(context, studio, signal)
		: undefined;
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
		lock: Promise<unknown>;
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
