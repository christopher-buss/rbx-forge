import type { LastBuild } from "../session/status.ts";
import type { CompileEvent, CompileReport } from "./diagnostics.ts";

/**
 * The quiet window: how long no compile may start before a build counts as
 * fresh. The roblox-ts compiler prints its start line about 61 ms after a
 * save, and the session reads compiler output every 250 ms; the rest is
 * margin.
 */
export const QUIET_WINDOW_MS = 750;

/**
 * What the watch-mode compiler did: a compile started or ended, or it wrote
 * any other output. An adapter turns a compiler's output into these.
 */
export type BuildEvent = CompileEvent | { type: "output" };

/**
 * What the watch-mode compiler is doing, from its build events and the time.
 * Pure: every call takes the time it happens at.
 */
export interface FreshnessTracker {
	/** A compile runs: a start event has no end event yet. */
	building: () => boolean;
	/**
	 * When a wait that began at `since` is answered, unless a compile starts
	 * first: one quiet window after `since` or the end of the last compile,
	 * whichever is later.
	 *
	 * @returns The time, or `undefined` while a compile runs or before the
	 *   first build.
	 */
	freshAt: (since: number) => number | undefined;
	lastBuild: () => LastBuild | undefined;
	/**
	 * Record one event.
	 *
	 * @returns The build an end event ended, else `undefined`.
	 */
	record: (event: BuildEvent, now: number) => LastBuild | undefined;
	/**
	 * When {@link FreshnessTracker.tick} ends a compile that no event ends:
	 * `undefined` unless an end event left start events unanswered.
	 */
	settleAt: () => number | undefined;
	/**
	 * Let time pass. Start events an end event left unanswered count as
	 * merged into it once no event comes until
	 * {@link FreshnessTracker.settleAt}.
	 *
	 * @returns `true` when this ended the compile.
	 */
	tick: (now: number) => boolean;
}

interface TrackerState {
	/** When the compiler last went idle: the start of the quiet window. */
	idleSince: number;
	lastBuild: LastBuild | undefined;
	lastEventAt: number;
	/** How many of `starts` came before the last end event. */
	leftover: number;
	longestMs: number;
	/** The times of the start events with no end event yet, oldest first. */
	starts: Array<number>;
}

/**
 * Track the builds of a watch-mode compiler. Each start event opens a compile
 * and each end event closes the oldest one. The roblox-ts compiler may start
 * a compile for a save during a compile and fold several of them into one
 * trailing compile, so an end event can leave start events that no end event
 * answers: those count as merged once no event comes for twice the longest
 * compile (at least one quiet window).
 *
 * @returns A tracker with no build.
 */
export function createFreshnessTracker(): FreshnessTracker {
	const state: TrackerState = {
		idleSince: 0,
		lastBuild: undefined,
		lastEventAt: 0,
		leftover: 0,
		longestMs: 0,
		starts: [],
	};
	return {
		building: () => state.starts.length > 0,
		freshAt: (since) => freshAt(state, since),
		lastBuild: () => state.lastBuild,
		record: (event, now) => record(state, event, now),
		settleAt: () => settleAt(state),
		tick: (now) => tick(state, now),
	};
}

function freshAt(state: TrackerState, since: number): number | undefined {
	if (state.lastBuild === undefined || state.starts.length > 0) {
		return undefined;
	}

	return Math.max(since, state.idleSince) + QUIET_WINDOW_MS;
}

function iso(ms: number): string {
	const time = new Date(ms);
	return time.toISOString();
}

/**
 * End the oldest compile at an end event.
 *
 * @param state - The tracker.
 * @param report - What the compile reported.
 * @param now - When it ended.
 * @returns The build.
 */
function finish(state: TrackerState, report: CompileReport, now: number): LastBuild {
	const startedAt = state.starts.shift() ?? now;
	state.leftover = state.starts.length;
	state.longestMs = Math.max(state.longestMs, now - startedAt);
	if (state.starts.length === 0) {
		state.idleSince = now;
	}

	const build = { ...report, at: iso(now), startedAt: iso(startedAt) };
	state.lastBuild = build;
	return build;
}

function record(state: TrackerState, event: BuildEvent, now: number): LastBuild | undefined {
	state.lastEventAt = now;
	if (event.type === "start") {
		state.starts.push(now);
	}

	return event.type === "end" ? finish(state, event.report, now) : undefined;
}

function settleAt(state: TrackerState): number | undefined {
	if (state.leftover === 0) {
		return undefined;
	}

	return state.lastEventAt + Math.max(QUIET_WINDOW_MS, 2 * state.longestMs);
}

function tick(state: TrackerState, now: number): boolean {
	const bound = settleAt(state);
	if (bound === undefined || now < bound) {
		return false;
	}

	state.starts = [];
	state.leftover = 0;
	state.idleSince = now;
	return true;
}
