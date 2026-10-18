import path from "node:path";
import { assert, describe, it } from "vitest";

import { createManualClock } from "../../test/helpers/manual-clock.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import { KEEP_HIDDEN_POLL_MS, KEEP_HIDDEN_START_BOUND_MS } from "../studio/window-hiding.ts";
import { createStatusStore } from "./status.ts";
import { createStudioReadiness } from "./studio-readiness.ts";

const PLACE = path.join(PROJECT, "game.rbxl");

/**
 * A readiness for a forge Studio launched hidden on the Windows user desktop,
 * whose watcher has not started yet.
 *
 * @param options - The pinned start time and whether sync is acknowledged.
 * @param options.isAcknowledged - Give the launch an acknowledged readiness.
 * @param options.startTime - The start time the launch recorded.
 * @returns The readiness and its controls.
 */
function hiddenWindowsReadiness({
	isAcknowledged = false,
	startTime = "42",
}: { isAcknowledged?: boolean; startTime?: string } = {}) {
	const native = createFakeNative({
		42: { alive: true, executablePath: "RobloxStudioBeta.exe", startTime: "42" },
	});
	const manual = createManualClock();
	const seams = createTestSeams({ clock: manual.clock, native: () => native.addon });
	seams.host.platform = "win32";
	const reporter = createRecordingReporter();
	const status = createStatusStore(
		{
			compiler: false,
			open: true,
			owner: null,
			pid: 500,
			port: 34872,
			sessionId: "s1",
			startedAt: "2026-01-01T00:00:00.000Z",
			syncback: false,
		},
		manual.clock.now,
		() => {},
	);
	const tracked: Array<Promise<unknown>> = [];
	const session = new AbortController();
	const readiness = createStudioReadiness(
		{ context: createCommandContext({ reporter, seams }), status },
		{
			signal: session.signal,
			track: (task) => {
				tracked.push(task);
			},
		},
		{ isAttached: true },
		{
			origin: "forge",
			place: PLACE,
			studio: { desktop: "hidden", pid: 42, startTime },
			...(isAcknowledged
				? { readiness: { close: () => {}, ready: Promise.resolve(true), url: "" } }
				: {}),
		},
	);
	const studio = native.processes.get(42);
	assert(studio !== undefined);
	return {
		done: async () => Promise.all(tracked),
		manual,
		readiness,
		reporter,
		status: () => status.snapshot().services.studio.status,
		studio,
	};
}

async function flushAsync(): Promise<void> {
	for (let tick = 0; tick < 20; tick++) {
		await Promise.resolve();
	}
}

describe(createStudioReadiness, () => {
	it.for([false, true])(
		"records Studio open only once its watcher hides the windows (acknowledged %s)",
		async (isAcknowledged, { expect }) => {
			expect.assertions(2);

			const run = hiddenWindowsReadiness({ isAcknowledged });
			run.readiness.onLock();
			await flushAsync();

			expect(run.status()).not.toBe("open");

			run.studio.windowHiding = true;
			run.manual.advance(KEEP_HIDDEN_POLL_MS);
			await run.readiness.open;

			expect(run.status()).toBe("open");
		},
	);

	it("warns and records Studio open when its watcher never starts", async ({ expect }) => {
		expect.assertions(2);

		const run = hiddenWindowsReadiness();
		run.readiness.onLock();
		run.manual.advance(KEEP_HIDDEN_START_BOUND_MS);
		await run.readiness.open;

		expect(run.status()).toBe("open");
		expect(run.reporter.events).toContainEqual({
			message:
				"Studio may show its windows: the watcher that keeps them hidden did not start within 10 s.",
			type: "warning",
		});
	});

	it("never records Studio open once the follow ends during the wait", async ({ expect }) => {
		expect.assertions(1);

		const run = hiddenWindowsReadiness();
		run.readiness.onLock();
		run.readiness.end();
		run.manual.advance(KEEP_HIDDEN_POLL_MS);
		await run.done();

		expect(run.status()).not.toBe("open");
	});

	it("waits for no watcher when the pinned process is another Studio", async ({ expect }) => {
		expect.assertions(1);

		const run = hiddenWindowsReadiness({ startTime: "43" });
		run.readiness.onLock();
		await run.readiness.open;

		expect(run.status()).toBe("open");
	});
});
