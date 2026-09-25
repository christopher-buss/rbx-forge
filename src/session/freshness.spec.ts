import { describe, expect, it } from "vitest";

import type { CompileEvent, Diagnostic } from "../compiler/diagnostics.ts";
import type { FreshnessTracker } from "./freshness.ts";
import { createFreshnessTracker, QUIET_WINDOW_MS } from "./freshness.ts";
import { isoTime as iso } from "./status.ts";

type BuildEvent = CompileEvent | undefined;

const START: BuildEvent = { type: "start" };
const CHANGE: BuildEvent = { type: "start" };
const FOUND: BuildEvent = { report: { diagnostics: [], errors: 0 }, type: "end" };
/** Output that neither starts nor ends a compile. */
const OUTPUT: BuildEvent = undefined;
const DIAGNOSTIC: Diagnostic = {
	code: "TS1005",
	column: 1,
	file: "src/a.ts",
	line: 1,
	message: "';' expected.",
	severity: "error",
};

/**
 * Feed timed events to one tracker.
 *
 * @param events - Each event with the time it came.
 * @returns The tracker after the last line.
 */
function feed(events: ReadonlyArray<readonly [number, BuildEvent]>): FreshnessTracker {
	const tracker = createFreshnessTracker();
	for (const [now, event] of events) {
		tracker.record(event, now);
	}

	return tracker;
}

describe(createFreshnessTracker, () => {
	it("should have no build and no answer before the first compile", () => {
		expect.assertions(3);

		const tracker = feed([[100, START]]);

		expect(tracker.lastBuild()).toBeUndefined();
		expect(tracker.building()).toBeTrue();
		expect(tracker.freshAt(0)).toBeUndefined();
	});

	it("should build from a start event to its end event", () => {
		expect.assertions(3);

		const tracker = createFreshnessTracker();
		tracker.record(START, 1000);
		tracker.record(OUTPUT, 1100);
		const build = tracker.record(
			{ report: { diagnostics: [DIAGNOSTIC], errors: 1 }, type: "end" },
			1400,
		);

		expect(build).toStrictEqual({
			at: iso(1400),
			diagnostics: [DIAGNOSTIC],
			errors: 1,
			startedAt: iso(1000),
		});
		expect(tracker.lastBuild()).toStrictEqual(build);
		expect(tracker.building()).toBeFalse();
	});

	it("should take a end event with no start event as a build that started when it ended", () => {
		expect.assertions(1);

		expect(feed([[500, FOUND]]).lastBuild()).toMatchObject({
			at: iso(500),
			startedAt: iso(500),
		});
	});

	it("should answer one quiet window after the call when no compile starts", () => {
		expect.assertions(2);

		// An edit that the compiler does not see: no start event comes.
		const tracker = feed([
			[0, START],
			[400, FOUND],
		]);

		expect(tracker.freshAt(5000)).toBe(5000 + QUIET_WINDOW_MS);
		expect(tracker.lastBuild()).toMatchObject({ at: iso(400) });
	});

	it("should answer one quiet window after a build that ended after the call", () => {
		expect.assertions(1);

		expect(
			feed([
				[0, START],
				[400, FOUND],
			]).freshAt(100),
		).toBe(400 + QUIET_WINDOW_MS);
	});

	it("should wait for the compile of a save just before the call", () => {
		expect.assertions(3);

		const tracker = feed([
			[0, START],
			[400, FOUND],
		]);
		const since = 5000;
		// The save came at 4990; its start event comes 61 ms later.
		tracker.record(CHANGE, 5051);

		expect(tracker.freshAt(since)).toBeUndefined();

		tracker.record(FOUND, 5400);

		expect(tracker.freshAt(since)).toBe(5400 + QUIET_WINDOW_MS);
		expect(tracker.lastBuild()).toMatchObject({ at: iso(5400), startedAt: iso(5051) });
	});

	it("should answer after the last compile of a burst of saves", () => {
		expect.assertions(1);

		const tracker = feed([
			[0, START],
			[400, FOUND],
			[1000, CHANGE],
			[1300, FOUND],
			[1500, CHANGE],
			[1800, FOUND],
			[2100, CHANGE],
			[2400, FOUND],
		]);

		expect(tracker.freshAt(900)).toBe(2400 + QUIET_WINDOW_MS);
	});

	it("should stay building until each start event has its end event", () => {
		expect.assertions(4);

		// A save during a compile: a second start event before the first
		// summary, then a trailing compile with its own summary.
		const tracker = feed([
			[0, START],
			[400, FOUND],
			[1000, CHANGE],
			[1200, CHANGE],
			[1400, FOUND],
		]);

		expect(tracker.building()).toBeTrue();
		expect(tracker.freshAt(900)).toBeUndefined();

		tracker.record(FOUND, 1700);

		expect(tracker.building()).toBeFalse();
		expect(tracker.lastBuild()).toMatchObject({ at: iso(1700), startedAt: iso(1200) });
	});

	it("should count start events that one end event ended as merged once the output stays silent", () => {
		expect.assertions(5);

		// Two start events, one compile: 400 ms is the longest compile.
		const tracker = feed([
			[0, START],
			[400, FOUND],
			[1000, CHANGE],
			[1200, CHANGE],
			[1400, FOUND],
		]);
		const bound = 1400 + Math.max(QUIET_WINDOW_MS, 2 * 400);

		expect(tracker.settleAt()).toBe(bound);
		expect([tracker.tick(bound - 1), tracker.building()]).toStrictEqual([false, true]);
		expect(tracker.tick(bound)).toBeTrue();
		expect([tracker.building(), tracker.tick(bound + 1)]).toStrictEqual([false, false]);
		expect(tracker.freshAt(900)).toBe(bound + QUIET_WINDOW_MS);
	});

	it("should have nothing to settle before any event", () => {
		expect.assertions(2);

		const tracker = createFreshnessTracker();

		expect(tracker.settleAt()).toBeUndefined();
		expect(tracker.tick(1_000_000)).toBeFalse();
	});

	it("should never settle the first compile, however long it runs", () => {
		expect.assertions(2);

		const tracker = feed([[0, START]]);

		expect(tracker.tick(1_000_000)).toBeFalse();
		expect(tracker.building()).toBeTrue();
	});

	it("should count open start events as merged once a new compile starts", () => {
		expect.assertions(3);

		const tracker = feed([
			[0, START],
			[400, FOUND],
			[1000, CHANGE],
			[1200, CHANGE],
			[1400, FOUND],
			[3000, CHANGE],
		]);
		// The new compile runs long, silent: it does not settle.
		const isSettled = tracker.tick(100_000);
		tracker.record(FOUND, 100_300);

		expect(isSettled).toBeFalse();
		expect(tracker.building()).toBeFalse();
		expect(tracker.lastBuild()).toMatchObject({ at: iso(100_300), startedAt: iso(3000) });
	});

	it("should wait twice the longest compile for merged start events", () => {
		expect.assertions(1);

		const tracker = feed([
			[0, START],
			[5000, FOUND],
			[6000, CHANGE],
			[6100, CHANGE],
			[6500, FOUND],
		]);

		expect(tracker.settleAt()).toBe(6500 + 2 * 5000);
	});

	it("should measure the silence from the last output line", () => {
		expect.assertions(2);

		const tracker = feed([
			[0, START],
			[400, FOUND],
			[1000, CHANGE],
			[1200, CHANGE],
			[1400, FOUND],
			[1600, OUTPUT],
		]);

		expect(tracker.settleAt()).toBe(1600 + 2 * 400);
		expect(tracker.tick(1400 + 2 * 400)).toBeFalse();
	});

	it("should have nothing to settle while every start event is answered or its compile runs", () => {
		expect.assertions(3);

		const tracker = feed([
			[0, START],
			[400, FOUND],
		]);

		expect(tracker.settleAt()).toBeUndefined();
		expect(tracker.tick(100_000)).toBeFalse();

		tracker.record(CHANGE, 100_000);

		expect(tracker.settleAt()).toBeUndefined();
	});
});
