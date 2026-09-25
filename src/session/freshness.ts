import type { CompileEvent, CompileReport } from "../compiler/diagnostics.ts";
import type { LastBuild } from "./status.ts";
import { isoTime } from "./status.ts";

/**
 * The quiet window: how long no compile may start before a build counts as
 * fresh. The roblox-ts compiler prints its start line about 61 ms after a
 * save, and the session reads compiler output every 250 ms; the rest is
 * margin.
 */
export const QUIET_WINDOW_MS = 750;

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
	 * Record one event: a compile's start or end, or `undefined` for any
	 * other output. An adapter turns a compiler's output into these.
	 *
	 * @returns The build an end event ended, else `undefined`.
	 */
	record: (event: CompileEvent | undefined, now: number) => LastBuild | undefined;
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
	/**
	 * When the compiler last went idle (the last end event, or when merged
	 * start events settled): the start of the quiet window.
	 */
	idleSince: number;
	lastBuild: LastBuild | undefined;
	lastEventAt: number;
	longestMs: number;
	/** The times of the start events with no end event yet, oldest first. */
	starts: Array<number>;
	/** The last end event left start events open: they may be merged. */
	unsettled: boolean;
}

/**
 * Track the builds of a watch-mode compiler. Each start event opens a compile
 * and each end event closes the oldest one. The roblox-ts compiler may start
 * a compile for a save during a compile and fold several of them into one
 * trailing compile, so an end event can leave start events that no end event
 * answers: those count as merged once no event comes for twice the longest
 * compile (at least one quiet window), or once a new start event comes.
 *
 * @returns A tracker with no build.
 */
export function createFreshnessTracker(): FreshnessTracker {
	const state: TrackerState = {
		idleSince: 0,
		lastBuild: undefined,
		lastEventAt: 0,
		longestMs: 0,
		starts: [],
		unsettled: false,
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
	state.unsettled = state.starts.length > 0;
	state.longestMs = Math.max(state.longestMs, now - startedAt);
	// While start events stay open, no wait is answered, and `tick` moves this.
	state.idleSince = now;

	const build = { ...report, at: isoTime(now), startedAt: isoTime(startedAt) };
	state.lastBuild = build;
	return build;
}

function record(
	state: TrackerState,
	event: CompileEvent | undefined,
	now: number,
): LastBuild | undefined {
	state.lastEventAt = now;
	switch (event?.type) {
		case "end": {
			return finish(state, event.report, now);
		}
		case "start": {
			// Open start events the last end event left were merged into it.
			if (state.unsettled) {
				state.starts = [];
				state.unsettled = false;
			}

			state.starts.push(now);
			return undefined;
		}
		case undefined: {
			return undefined;
		}
	}
}

function settleAt(state: TrackerState): number | undefined {
	if (!state.unsettled) {
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
	state.unsettled = false;
	state.idleSince = bound;
	return true;
}
