import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { createManualClock } from "../../test/helpers/manual-clock.ts";
import { ForgeError } from "../errors.ts";
import type { BuildWatch } from "./build-watch.ts";
import { createBuildWatch } from "./build-watch.ts";
import { QUIET_WINDOW_MS } from "./freshness.ts";
import type { StatusRecorder } from "./status.ts";

const START = "[10:00:00] Starting compilation in watch mode...";
const CHANGE = "[10:00:01] File change detected. Starting incremental compilation...";
const FOUND = "[10:00:02] Found 0 errors. Watching for file changes.";
const TIMEOUT_MS = 60_000;

interface Harness {
	/** Move time on, then let the waits run. */
	advanceAsync: (ms: number) => Promise<void>;
	/** Read a line at the current time, then let the waits run. */
	lineAsync: (line: string) => Promise<void>;
	recorder: {
		building: Mock<StatusRecorder["building"]>;
		compiled: Mock<StatusRecorder["compiled"]>;
	};
	/** Start a wait, and record when it settled. */
	wait: (timeoutMs?: number) => { settled: () => boolean; wait: Promise<void> };
	watch: BuildWatch;
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

function makeWatch(tracks = true): Harness {
	const manual = createManualClock(0);
	const recorder = {
		building: vi.fn<StatusRecorder["building"]>(),
		compiled: vi.fn<StatusRecorder["compiled"]>(),
	};
	const watch = createBuildWatch({ clock: manual.clock, recorder, tracks });
	return {
		advanceAsync: async (ms) => {
			manual.advance(ms);
			await flushAsync();
		},
		lineAsync: async (line) => {
			watch.read(line);
			await flushAsync();
		},
		recorder,
		wait: (timeoutMs = TIMEOUT_MS) => {
			let isSettled = false;
			const wait = watch.waitAsync(timeoutMs).finally(() => {
				isSettled = true;
			});
			// The test awaits it; this only keeps an early rejection handled.
			wait.catch(() => {});
			return { settled: () => isSettled, wait };
		},
		watch,
	};
}

/**
 * A watch whose compiler finished its first compile at 400 ms, now at 5 s.
 *
 * @returns The harness.
 */
async function builtAsync(): Promise<Harness> {
	const harness = makeWatch();
	await harness.lineAsync(START);
	await harness.advanceAsync(400);
	await harness.lineAsync(FOUND);
	await harness.advanceAsync(4600);
	return harness;
}

describe(createBuildWatch, () => {
	it("should answer at once when the session tracks no compiler", async () => {
		expect.assertions(1);

		const { wait } = makeWatch(false);

		await expect(wait().wait).resolves.toBeUndefined();
	});

	it("should tell the status each compile's start and build", async () => {
		expect.assertions(2);

		const { advanceAsync, lineAsync, recorder } = makeWatch();
		await lineAsync(START);
		await advanceAsync(400);
		await lineAsync("compiling as game..");
		await lineAsync(FOUND);

		expect(recorder.building.mock.calls).toStrictEqual([[true]]);
		expect(recorder.compiled).toHaveBeenCalledExactlyOnceWith(
			{
				at: "1970-01-01T00:00:00.400Z",
				diagnostics: [],
				errors: 0,
				startedAt: "1970-01-01T00:00:00.000Z",
			},
			false,
		);
	});

	it("should return the build that ended a line, and nothing for other lines", () => {
		expect.assertions(2);

		const { watch } = makeWatch();

		expect(watch.read(START)).toBeUndefined();
		expect(watch.read(FOUND)).toMatchObject({ errors: 0 });
	});

	it("should wait for the first compile of a session that is starting", async () => {
		expect.assertions(3);

		const { advanceAsync, lineAsync, wait } = makeWatch();
		const waiting = wait();
		await advanceAsync(10_000);
		const isEarly = waiting.settled();
		await lineAsync(START);
		await advanceAsync(400);
		await lineAsync(FOUND);
		await advanceAsync(QUIET_WINDOW_MS - 1);
		const isBeforeWindow = waiting.settled();
		await advanceAsync(1);

		expect(isEarly).toBeFalse();
		expect(isBeforeWindow).toBeFalse();
		await expect(waiting.wait).resolves.toBeUndefined();
	});

	it("should answer one quiet window after an edit that starts no compile", async () => {
		expect.assertions(2);

		const { advanceAsync, wait } = await builtAsync();
		const waiting = wait();
		await advanceAsync(QUIET_WINDOW_MS - 1);
		const isEarly = waiting.settled();
		await advanceAsync(1);

		expect(isEarly).toBeFalse();
		await expect(waiting.wait).resolves.toBeUndefined();
	});

	it("should wait for the compile of a save just before the call", async () => {
		expect.assertions(3);

		const { advanceAsync, lineAsync, recorder, wait } = await builtAsync();
		const waiting = wait();
		// The start line of a save 10 ms before the call is read 300 ms later.
		await advanceAsync(300);
		await lineAsync(CHANGE);
		await advanceAsync(QUIET_WINDOW_MS);
		const isSettledWhileBuilding = waiting.settled();
		await lineAsync(FOUND);
		await advanceAsync(QUIET_WINDOW_MS);

		expect(isSettledWhileBuilding).toBeFalse();
		await expect(waiting.wait).resolves.toBeUndefined();
		expect(recorder.compiled).toHaveBeenLastCalledWith(
			expect.objectContaining({ at: "1970-01-01T00:00:06.050Z" }),
			false,
		);
	});

	it("should answer only after the last compile of a burst of saves", async () => {
		expect.assertions(2);

		const { advanceAsync, lineAsync, wait } = await builtAsync();
		const waiting = wait();
		for (let save = 0; save < 3; save += 1) {
			await advanceAsync(200);
			await lineAsync(CHANGE);
			await advanceAsync(300);
			await lineAsync(FOUND);
		}

		await advanceAsync(QUIET_WINDOW_MS - 1);
		const isEarly = waiting.settled();
		await advanceAsync(1);

		expect(isEarly).toBeFalse();
		await expect(waiting.wait).resolves.toBeUndefined();
	});

	it("should answer once start lines that one summary line ended count as merged", async () => {
		expect.assertions(3);

		const { advanceAsync, lineAsync, recorder, wait } = await builtAsync();
		await lineAsync(CHANGE);
		await lineAsync(CHANGE);
		await advanceAsync(400);
		await lineAsync(FOUND);
		const waiting = wait();
		// Twice the longest compile (400 ms) with no output.
		await advanceAsync(800);
		const settled = recorder.building.mock.lastCall;
		await advanceAsync(QUIET_WINDOW_MS - 1);
		const isEarly = waiting.settled();
		await advanceAsync(1);

		expect(settled).toStrictEqual([false]);
		expect(isEarly).toBeFalse();
		await expect(waiting.wait).resolves.toBeUndefined();
	});

	it("should settle merged start lines when the status is read", async () => {
		expect.assertions(2);

		const { advanceAsync, lineAsync, recorder, watch } = await builtAsync();
		await lineAsync(CHANGE);
		await lineAsync(CHANGE);
		await lineAsync(FOUND);
		watch.tick();
		const beforeBound = recorder.building.mock.lastCall;
		await advanceAsync(800);
		watch.tick();

		expect(beforeBound).toStrictEqual([true]);
		expect(recorder.building.mock.lastCall).toStrictEqual([false]);
	});

	it("should fail with compile_timeout when no fresh build comes in time", async () => {
		expect.assertions(1);

		const { advanceAsync, lineAsync, wait } = await builtAsync();
		const waiting = wait(2000);
		await lineAsync(CHANGE);
		await advanceAsync(2000);

		await expect(waiting.wait).rejects.toMatchObject({
			code: "compile_timeout",
			details: { building: true, timeoutMs: 2000 },
		});
	});

	it("should tell why a wait timed out before the first compile", async () => {
		expect.assertions(1);

		const { advanceAsync, wait } = makeWatch();
		const waiting = wait(2000);
		await advanceAsync(2000);

		await expect(waiting.wait).rejects.toThrow("the first compile has not ended");
	});

	it("should tell why a wait timed out while compiles kept starting", async () => {
		expect.assertions(1);

		const { advanceAsync, lineAsync, wait } = await builtAsync();
		const waiting = wait(2000);
		for (let save = 0; save < 4; save += 1) {
			await lineAsync(CHANGE);
			await advanceAsync(100);
			await lineAsync(FOUND);
			await advanceAsync(400);
		}

		await expect(waiting.wait).rejects.toThrow("compiles kept starting");
	});

	it("should fail every wait, now and later, once the compiler exits", async () => {
		expect.assertions(3);

		const { lineAsync, recorder, wait, watch } = await builtAsync();
		const waiting = wait();
		await lineAsync(CHANGE);
		watch.fail(new ForgeError("service_failed", "The compiler exited."));
		// The first failure wins.
		watch.close();

		// The compile that ran ends with the compiler.
		expect(recorder.building.mock.lastCall).toStrictEqual([false]);
		await expect(waiting.wait).rejects.toMatchObject({ code: "service_failed" });
		await expect(wait().wait).rejects.toMatchObject({ code: "service_failed" });
	});

	it("should tell when the quiet window is longer than the wait", async () => {
		expect.assertions(1);

		const { advanceAsync, wait } = await builtAsync();
		const waiting = wait(0);
		await advanceAsync(0);

		await expect(waiting.wait).rejects.toThrow(
			`the quiet window (${QUIET_WINDOW_MS} ms) is longer than the wait`,
		);
	});

	it("should fail every wait with not_running once the session stops", async () => {
		expect.assertions(1);

		const { wait, watch } = makeWatch();
		watch.close();

		await expect(wait().wait).rejects.toMatchObject({ code: "not_running" });
	});
});
