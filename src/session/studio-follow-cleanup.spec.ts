import { fromPartial } from "@total-typescript/shoehorn";

import path from "node:path";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import { createManualClock } from "../../test/helpers/manual-clock.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { createServiceParts } from "./service-parts.ts";
import { createStatusStore } from "./status.ts";
import { followSessionStudio, leaveStudio } from "./studio-part.ts";
import { FILE_POLL_MS } from "./worker-context.ts";

function followingStudio(platform: NodeJS.Platform = "win32") {
	const memory = createMemoryFileSystem({
		"game.rbxl": "place",
		"game.rbxl.lock": `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
	});
	const native = createFakeNative({
		42: {
			alive: true,
			blocked: true,
			desktop: "hidden",
			dialog: { button: "Continue", title: "Lighting Technology Migration" },
			executablePath: "RobloxStudioBeta.exe",
			startTime: "42",
		},
	});
	const inspected = Promise.withResolvers<void>();
	const inspection = Promise.withResolvers<void>();
	const pin = native.addon.pinProcess;
	native.addon.pinProcess = (pid) => {
		const current = pin(pid);
		assert(current !== null);
		return {
			...current,
			dismissDialog: async (...parameters: Parameters<typeof current.dismissDialog>) => {
				inspected.resolve();
				await inspection.promise;
				return current.dismissDialog(...parameters);
			},
		};
	};

	const manual = createManualClock(5000);
	const seams = createTestSeams({
		clock: manual.clock,
		fileSystem: memory.fileSystem,
		native: () => native.addon,
	});
	seams.host.platform = platform;
	const context = createCommandContext({ seams });
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
	const abort = new AbortController();
	const tracked: Array<Promise<unknown>> = [];
	const scope = {
		signal: abort.signal,
		track: (task: Promise<unknown>) => {
			tracked.push(task);
		},
	};
	const state = { isAttached: false };
	const parts = createServiceParts(
		{ context, directory: path.join(PROJECT, ".forge/sessions/s1"), status },
		fromPartial(scope),
	);
	const { open } = followSessionStudio(
		{ context, idle: { activity: () => {} }, status },
		scope,
		{ parts, state },
		{
			origin: "forge",
			place: path.join(PROJECT, "game.rbxl"),
			studio: { desktop: "hidden", pid: 42, startTime: "42" },
		},
	);
	onTestFinished(async () => {
		abort.abort();
		inspection.resolve();
		await Promise.all(tracked);
	});
	const studio = native.processes.get(42);
	assert(studio !== undefined);
	return {
		closePlace: () => {
			memory.fileSystem.rmSync(path.join(PROJECT, "game.rbxl.lock"));
			manual.advance(FILE_POLL_MS);
		},
		done: async () => Promise.all(tracked),
		finishInspection: () => {
			inspection.resolve();
		},
		inspected: inspected.promise,
		leave: () => {
			leaveStudio(state, status);
		},
		open,
		status,
		studio,
	};
}

async function flushAsync(): Promise<void> {
	for (let tick = 0; tick < 20; tick++) {
		await Promise.resolve();
	}
}

describe("studio follow completion", () => {
	it.for(["darwin", "linux"] as const)(
		"leaves Windows migration dialogs alone on a %s host",
		async (platform) => {
			expect.assertions(1);

			const run = followingStudio(platform);
			run.finishInspection();
			await run.open;
			await flushAsync();

			expect(run.studio).toMatchObject({ alive: true, blocked: true });
		},
	);

	it("records Studio closed only after its in-flight native dialog inspection ends", async () => {
		expect.assertions(3);

		const run = followingStudio();
		await run.open;
		await run.inspected;
		run.closePlace();
		await flushAsync();

		expect(run.status.snapshot().services.studio.status).toBe("open");

		run.finishInspection();
		await run.done();

		expect(run.status.snapshot().services.studio.status).toBe("closed");
		expect(run.studio).toMatchObject({ alive: true, blocked: false });
	});

	it("keeps a detached Studio off when its earlier close observation finishes after release", async () => {
		expect.assertions(2);

		const run = followingStudio();
		await run.open;
		await run.inspected;
		run.closePlace();
		await flushAsync();
		run.leave();

		expect(run.status.snapshot().services.studio.status).toBe("off");

		run.finishInspection();
		await run.done();

		expect(run.status.snapshot().services.studio.status).toBe("off");
	});
});
