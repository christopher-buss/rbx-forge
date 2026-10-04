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
import { watchHiddenLightingAsync } from "../studio/lighting-dialog.ts";
import { followSessionStudio } from "./studio-part.ts";

function followingLightingStudio({
	aborted = false,
	desktop = "hidden",
	dismissFailsOnce = false,
	hasDialog = true,
	hasLock = true,
	identity,
	kind,
}: {
	aborted?: boolean;
	desktop?: "hidden" | "user";
	dismissFailsOnce?: boolean;
	hasDialog?: boolean;
	hasLock?: boolean;
	identity?: { pid: number; startTime: string };
	kind?: "gone" | "reused";
} = {}) {
	const memory = createMemoryFileSystem({
		"game.rbxl": "place",
		"game.rbxl.lock": `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
	});
	const native = createFakeNative({
		42: {
			alive: true,
			blocked: hasDialog,
			desktop,
			...(hasDialog
				? { dialog: { button: "Continue", title: "Lighting Technology Migration" } }
				: {}),
			executablePath: "RobloxStudioBeta.exe",
		},
	});
	const pinned = native.addon.pinProcess(42);
	assert(pinned !== null);
	if (dismissFailsOnce) {
		let hasFailed = false;
		const pin = native.addon.pinProcess;
		native.addon.pinProcess = (pid) => {
			const current = pin(pid);
			assert(current !== null);
			return {
				...current,
				dismissDialog: async (...parameters) => {
					if (!hasFailed) {
						hasFailed = true;
						throw new Error("Studio accessibility is still initializing.");
					}

					return current.dismissDialog(...parameters);
				},
			};
		};
	}

	if (kind !== undefined) {
		const races = { gone: null, reused: { ...pinned, startTime: "reused" } };
		const pins = [pinned, races[kind]];
		native.addon.pinProcess = () => pins.shift() ?? null;
	}

	if (!hasLock) {
		memory.fileSystem.rmSync(path.join(PROJECT, "game.rbxl.lock"));
	}

	const manual = createManualClock(5000);
	const seams = createTestSeams({
		clock: manual.clock,
		fileSystem: memory.fileSystem,
		native: () => native.addon,
	});
	seams.host.platform = "win32";
	const abort = new AbortController();
	if (aborted) {
		abort.abort();
	}

	const tracked: Array<Promise<unknown>> = [];
	onTestFinished(async () => {
		abort.abort();
		await Promise.all(tracked);
	});
	followSessionStudio(
		{
			context: createCommandContext({ seams }),
			idle: { activity: () => {} },
			status: fromPartial({ snapshot: makeStatus, studio: () => {} }),
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
			studio: { desktop, pid: 42, startTime: "42", ...identity },
		},
	);
	const studio = native.processes.get(42);
	assert(studio !== undefined);
	return { manual, memory, studio };
}

describe("startup Lighting identity checks", () => {
	it("ends observation if its polling timer fails while the session remains active", async () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem({
			"game.rbxl": "place",
			"game.rbxl.lock": `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
		});
		const native = createFakeNative({
			42: { alive: true, desktop: "hidden", executablePath: "RobloxStudioBeta.exe" },
		});
		const manual = createManualClock(5000);
		const seams = createTestSeams({
			clock: failingFirstSleep(manual.clock),
			fileSystem: memory.fileSystem,
			native: () => native.addon,
		});
		const abort = new AbortController();
		const watched = watchHiddenLightingAsync(
			seams,
			{ place: path.join(PROJECT, "game.rbxl") },
			{ openingTimeoutMs: 180_000, signal: abort.signal },
		);
		onTestFinished(async () => {
			abort.abort();
			await watched;
		});

		await expect(watched).resolves.toBeUndefined();
	});

	it("retries a temporary accessibility failure while Studio finishes opening", async () => {
		expect.assertions(2);

		const { manual, studio } = followingLightingStudio({ dismissFailsOnce: true });
		for (let tick = 0; tick < 20; tick++) {
			await Promise.resolve();
		}

		expect(studio.blocked).toBeTrue();

		manual.advance(500);
		for (let tick = 0; tick < 20; tick++) {
			await Promise.resolve();
		}

		expect(studio.blocked).toBeFalse();
	});

	it.for([
		{ pid: 43, startTime: "42" },
		{ pid: 42, startTime: "old" },
	])("leaves another recorded Studio identity %j untouched", async (identity) => {
		expect.assertions(1);

		const { studio } = followingLightingStudio({ identity });
		for (let tick = 0; tick < 20; tick++) {
			await Promise.resolve();
		}

		expect(studio.blocked).toBeTrue();
	});

	it("ends migration handling on the user desktop even if Studio moves to hidden later", async () => {
		expect.assertions(2);

		const { manual, studio } = followingLightingStudio({ desktop: "user" });
		for (let tick = 0; tick < 20; tick++) {
			await Promise.resolve();
		}

		expect(studio.blocked).toBeTrue();

		studio.desktop = "hidden";
		manual.advance(500);
		for (let tick = 0; tick < 20; tick++) {
			await Promise.resolve();
		}

		expect(studio.blocked).toBeTrue();
	});

	it("leaves a migration prompt untouched after the Studio follow has ended", async () => {
		expect.assertions(1);

		const { studio } = followingLightingStudio({ aborted: true });
		for (let tick = 0; tick < 20; tick++) {
			await Promise.resolve();
		}

		expect(studio.blocked).toBeTrue();
	});

	it("ends migration handling once thirty seconds have passed since observing the lock", async () => {
		expect.assertions(1);

		const { manual, studio } = followingLightingStudio({ hasDialog: false });
		for (let tick = 0; tick < 20; tick++) {
			await Promise.resolve();
		}

		studio.blocked = true;
		studio.dialog = { button: "Continue", title: "Lighting Technology Migration" };
		manual.advance(30_000);
		for (let tick = 0; tick < 20; tick++) {
			await Promise.resolve();
		}

		expect(studio.blocked).toBeTrue();
	});

	it("keeps one deadline after observing the lock rather than restarting it on every poll", async () => {
		expect.assertions(1);

		const { manual, studio } = followingLightingStudio({ hasDialog: false });
		for (let tick = 0; tick < 20; tick++) {
			await Promise.resolve();
		}

		manual.advance(15_000);
		for (let tick = 0; tick < 20; tick++) {
			await Promise.resolve();
		}

		studio.blocked = true;
		studio.dialog = { button: "Continue", title: "Lighting Technology Migration" };
		manual.advance(15_000);
		for (let tick = 0; tick < 20; tick++) {
			await Promise.resolve();
		}

		expect(studio.blocked).toBeTrue();
	});

	it("stops after dismissing the startup migration rather than pressing a later prompt", async () => {
		expect.assertions(2);

		const { manual, studio } = followingLightingStudio();
		for (let tick = 0; tick < 20; tick++) {
			await Promise.resolve();
		}

		expect(studio.blocked).toBeFalse();

		studio.blocked = true;
		studio.dialog = { button: "Continue", title: "Lighting Technology Migration" };
		manual.advance(500);
		for (let tick = 0; tick < 20; tick++) {
			await Promise.resolve();
		}

		expect(studio.blocked).toBeTrue();
	});

	it("does not handle a prompt when the place opens at its expired opening deadline", async () => {
		expect.assertions(1);

		const { manual, memory, studio } = followingLightingStudio({ hasLock: false });
		for (let tick = 0; tick < 20; tick++) {
			await Promise.resolve();
		}

		memory.fileSystem.writeFileSync(
			path.join(PROJECT, "game.rbxl.lock"),
			`42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
		);
		manual.advance(180_000);
		for (let tick = 0; tick < 20; tick++) {
			await Promise.resolve();
		}

		expect(studio.blocked).toBeTrue();
	});

	it.for(["gone", "reused"] as const)(
		"leaves the dialog untouched when Studio is %s after verifying its lock",
		async (kind) => {
			expect.assertions(2);

			const { studio } = followingLightingStudio({ kind });
			for (let tick = 0; tick < 20; tick++) {
				await Promise.resolve();
			}

			expect(studio.blocked).toBeTrue();
			expect(studio.dialog).toStrictEqual({
				button: "Continue",
				title: "Lighting Technology Migration",
			});
		},
	);
});

function failingFirstSleep(clock: ReturnType<typeof createManualClock>["clock"]) {
	let hasFailed = false;
	return {
		...clock,
		sleep: async (...parameters: Parameters<typeof clock.sleep>) => {
			if (!hasFailed) {
				hasFailed = true;
				throw new Error("Polling timer unavailable.");
			}

			await clock.sleep(...parameters);
		},
	};
}
