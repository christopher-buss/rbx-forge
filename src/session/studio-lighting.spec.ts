import { fromPartial } from "@total-typescript/shoehorn";

import path from "node:path";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import { makeStatus } from "../../test/helpers/fake-session.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { followSessionStudio } from "./studio-part.ts";

async function settleAsync() {
	for (let tick = 0; tick < 20; tick++) {
		await Promise.resolve();
	}
}

describe("hidden Studio startup dialogs", () => {
	it.for([0, 45_000])(
		"dismisses migration after readiness when the lock takes %i ms",
		async (lockDelay) => {
			expect.assertions(2);

			const memory = createMemoryFileSystem({
				"game.rbxl": "place",
				"game.rbxl.lock": `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
			});
			const native = createFakeNative({
				42: { alive: true, desktop: "hidden", executablePath: "RobloxStudioBeta.exe" },
			});
			const manual = createManualClock();
			const seams = createTestSeams({
				clock: manual.clock,
				fileSystem: memory.fileSystem,
				native: () => native.addon,
			});
			seams.host.platform = "win32";
			const abort = new AbortController();
			const tracked: Array<Promise<unknown>> = [];
			onTestFinished(async () => {
				abort.abort();
				await Promise.all(tracked);
			});
			memory.fileSystem.rmSync(path.join(PROJECT, "game.rbxl.lock"));
			const following = followSessionStudio(
				{
					context: createCommandContext({ seams }),
					idle: { activity: () => {} },
					status: fromPartial({ snapshot: () => makeStatus(), studio: () => {} }),
				},
				{
					signal: abort.signal,
					track: (promise) => {
						tracked.push(promise);
					},
				},
				{
					parts: fromPartial({ stop: () => {} }),
					state: { isAttached: false },
				},
				{
					origin: "forge",
					place: path.join(PROJECT, "game.rbxl"),
					studio: { desktop: "hidden", pid: 42, startTime: "42" },
				},
			);
			manual.advance(lockDelay);
			await settleAsync();
			memory.fileSystem.writeFileSync(
				path.join(PROJECT, "game.rbxl.lock"),
				`42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
			);
			manual.advance(500);
			await settleAsync();
			await following.open;
			manual.advance(7000);
			await settleAsync();
			const studio = native.processes.get(42);
			assert(studio !== undefined);
			studio.blocked = true;
			studio.dialog = { button: "Continue", title: "Lighting Technology Migration" };
			manual.advance(500);
			await settleAsync();

			expect(studio.blocked).toBeFalse();
			expect(memory.fileSystem.readFileSync(path.join(PROJECT, "game.rbxl"), "utf8")).toBe(
				"place",
			);
		},
	);
});
