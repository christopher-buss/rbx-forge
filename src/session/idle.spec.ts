import { describe, expect, it, vi } from "vitest";

import { createManualClock } from "../../test/helpers/manual-clock.ts";
import { createRecordingReporter } from "../../test/helpers/seams.ts";
import type { RecordingReporter } from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import type { IdleSetup } from "./idle.ts";
import { createIdleTracker, IDLE_STOP, stopWhenIdleAsync } from "./idle.ts";
import type { PartStopper, PartStops } from "./part-stops.ts";

const MINUTE_MS = 60_000;
const NOTHING: PartStops = { ending: false, kept: [], stopped: [] };

describe(createIdleTracker, () => {
	it("should be idle one timeout after its start with no activity", () => {
		expect.assertions(1);

		const tracker = createIdleTracker(30, 1000);

		expect(tracker.idleAt()).toBe(1000 + 30 * MINUTE_MS);
	});

	it("should start the time again on each activity", () => {
		expect.assertions(2);

		const tracker = createIdleTracker(2, 0);
		tracker.activity(90_000);

		expect(tracker.idleAt()).toBe(90_000 + 2 * MINUTE_MS);

		tracker.activity(100_000);

		expect(tracker.idleAt()).toBe(100_000 + 2 * MINUTE_MS);
	});

	it("should take a fraction of a minute", () => {
		expect.assertions(1);

		expect(createIdleTracker(0.5, 0).idleAt()).toBe(30_000);
	});

	it("should never be idle with a timeout of 0", () => {
		expect.assertions(1);

		const tracker = createIdleTracker(0, 0);
		tracker.activity(5000);

		expect(tracker.idleAt()).toBeUndefined();
	});
});

interface IdleRun {
	abort: AbortController;
	clock: ReturnType<typeof createManualClock>;
	done: Promise<void>;
	reporter: RecordingReporter;
	setup: IdleSetup;
	stopAsync: ReturnType<typeof vi.fn<PartStopper>>;
}

function watchIdle(minutes: number, stops: ForgeError | PartStops = NOTHING): IdleRun {
	const clock = createManualClock();
	const abort = new AbortController();
	const stopAsync = vi.fn<PartStopper>(async () => {
		if (stops instanceof ForgeError) {
			throw stops;
		}

		return stops;
	});
	const reporter = createRecordingReporter();
	const setup: IdleSetup = {
		clock: clock.clock,
		idle: createIdleTracker(minutes, 0),
		minutes,
		reporter,
		stopAsync,
	};
	return {
		abort,
		clock,
		done: stopWhenIdleAsync(setup, abort.signal),
		reporter,
		setup,
		stopAsync,
	};
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

describe(stopWhenIdleAsync, () => {
	it("should stop the parts with no owner once the timeout passed with no activity", async () => {
		expect.assertions(2);

		const run = watchIdle(1);
		run.clock.advance(MINUTE_MS - 1);
		await flushAsync();

		expect(run.stopAsync).not.toHaveBeenCalled();

		run.clock.advance(1);
		await flushAsync();

		expect(run.stopAsync).toHaveBeenCalledExactlyOnceWith(IDLE_STOP);
	});

	it("should wait for the timeout again after an activity", async () => {
		expect.assertions(2);

		const run = watchIdle(1);
		run.clock.advance(30_000);
		run.setup.idle.activity(run.clock.clock.now());
		run.clock.advance(30_000);
		await flushAsync();

		expect(run.stopAsync).not.toHaveBeenCalled();

		run.clock.advance(30_000);
		await flushAsync();

		expect(run.stopAsync).toHaveBeenCalledOnce();
	});

	it("should stop again only after one more timeout with no activity", async () => {
		expect.assertions(2);

		const run = watchIdle(1);
		run.clock.advance(MINUTE_MS);
		await flushAsync();
		run.clock.advance(MINUTE_MS - 1);
		await flushAsync();

		expect(run.stopAsync).toHaveBeenCalledOnce();

		run.clock.advance(1);
		await flushAsync();

		expect(run.stopAsync).toHaveBeenCalledTimes(2);
	});

	it("should report the parts it stopped", async () => {
		expect.assertions(1);

		const run = watchIdle(30, { ending: true, kept: [], stopped: ["studio", "compiler"] });
		run.clock.advance(30 * MINUTE_MS);
		await flushAsync();
		run.abort.abort();
		await run.done;

		expect(run.reporter.events).toStrictEqual([
			{
				message: "No activity for 30 min: stopped studio, compiler.",
				type: "info",
			},
		]);
	});

	it("should report nothing when it stopped no part", async () => {
		expect.assertions(1);

		const run = watchIdle(1);
		run.clock.advance(MINUTE_MS);
		await flushAsync();
		run.abort.abort();
		await run.done;

		expect(run.reporter.events).toStrictEqual([]);
	});

	it("should end quietly when the session is already stopping", async () => {
		expect.assertions(2);

		const run = watchIdle(1, new ForgeError("not_running", "stopping"));
		run.clock.advance(MINUTE_MS);
		await flushAsync();
		run.abort.abort();

		await expect(run.done).resolves.toBeUndefined();
		expect(run.reporter.events).toStrictEqual([]);
	});

	it("should never stop with a timeout of 0, and leave no timer", async () => {
		expect.assertions(2);

		const run = watchIdle(0);
		await run.done;
		run.clock.advance(1000 * MINUTE_MS);

		expect(run.stopAsync).not.toHaveBeenCalled();
		expect(run.clock.pending()).toBe(0);
	});

	it("should end with the session, and leave no timer", async () => {
		expect.assertions(2);

		const run = watchIdle(1);
		run.abort.abort();
		await run.done;
		run.clock.advance(MINUTE_MS);

		expect(run.stopAsync).not.toHaveBeenCalled();
		expect(run.clock.pending()).toBe(0);
	});

	it("should not stop once the session ended during the stop", async () => {
		expect.assertions(1);

		const run = watchIdle(1);
		run.stopAsync.mockImplementation(async () => {
			run.abort.abort();
			return NOTHING;
		});
		run.clock.advance(MINUTE_MS);
		await run.done;
		run.clock.advance(MINUTE_MS);

		expect(run.clock.pending()).toBe(0);
	});
});
