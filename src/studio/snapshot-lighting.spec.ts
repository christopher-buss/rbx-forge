import path from "node:path";
import { assert, describe, expect, it } from "vitest";

import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import type { DetachedSpawn } from "../native/addon.ts";
import { createSnapshotLightingLauncher } from "./snapshot-lighting-launcher.ts";
import { runSnapshotLightingAsync } from "./snapshot-lighting.ts";

function watchingSnapshot({
	exits = false,
	hasDialog = true,
	hasLock = true,
	identity = "42",
} = {}) {
	let now = 0;
	const place = path.join(PROJECT, "game.rbxl");
	const memory = createMemoryFileSystem({
		"game.rbxl": "place",
		...(hasLock ? { "game.rbxl.lock": `42\nRobloxStudio\n${TEST_HOSTNAME}\n` } : {}),
	});
	const native = createFakeNative({
		42: {
			alive: true,
			blocked: false,
			desktop: "hidden",
			executablePath: "RobloxStudioBeta.exe",
			startTime: "42",
		},
		43: {
			alive: true,
			blocked: true,
			desktop: "hidden",
			dialog: { button: "Continue", title: "Lighting Technology Migration" },
			executablePath: "RobloxStudioBeta.exe",
		},
	});
	const studio = native.processes.get(42);
	assert(studio !== undefined);
	const seams = createTestSeams({
		clock: {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
				if (now === 7000 && hasDialog) {
					studio.blocked = true;
					studio.dialog = { button: "Continue", title: "Lighting Technology Migration" };
				}

				if (exits && now >= 500) {
					studio.alive = false;
				}
			},
		},
		fileSystem: memory.fileSystem,
		native: () => native.addon,
	});
	return {
		native,
		now: () => now,
		payload: JSON.stringify({ pid: 42, place, startTime: identity }),
		seams,
		studio,
	};
}

describe("hidden snapshot Lighting watcher", () => {
	it.for(["gone", "exited"] as const)(
		"ignores a Studio that has %s before its watcher starts",
		async (kind) => {
			expect.assertions(1);

			const run = watchingSnapshot();
			const changes = { exited: { exitsAfterPin: true }, gone: { alive: false } };
			Object.assign(run.studio, changes[kind]);
			await runSnapshotLightingAsync(run.seams, run.payload);

			expect(run.now()).toBe(0);
		},
	);

	it("dismisses a prompt seven seconds after the place lock while leaving other Studios alone", async () => {
		expect.assertions(3);

		const run = watchingSnapshot();
		await runSnapshotLightingAsync(run.seams, run.payload);

		expect(run.studio).toMatchObject({ alive: true, blocked: false });
		expect(run.native.processes.get(43)).toMatchObject({ alive: true, blocked: true });
		expect(run.now()).toBe(7000);
	});

	it("exits as soon as the launched Studio exits", async () => {
		expect.assertions(1);

		const run = watchingSnapshot({ exits: true });
		await runSnapshotLightingAsync(run.seams, run.payload);

		expect(run.now()).toBe(500);
	});

	it("exits after the bounded opening wait if no place lock appears", async () => {
		expect.assertions(1);

		const run = watchingSnapshot({ hasDialog: false, hasLock: false });
		await runSnapshotLightingAsync(run.seams, run.payload);

		expect(run.now()).toBe(180_000);
	});

	it("exits after the post-lock wait when there is no migration prompt", async () => {
		expect.assertions(1);

		const run = watchingSnapshot({ hasDialog: false });
		await runSnapshotLightingAsync(run.seams, run.payload);

		expect(run.now()).toBe(30_000);
	});

	it("leaves a reused Studio PID untouched", async () => {
		expect.assertions(2);

		const run = watchingSnapshot({ identity: "41" });
		await runSnapshotLightingAsync(run.seams, run.payload);

		expect(run.studio).toMatchObject({ alive: true, blocked: false });
		expect(run.now()).toBe(0);
	});
});

describe("snapshot Lighting helper launch", () => {
	it("starts Node with one exact place identity and a defined environment", () => {
		expect.assertions(2);

		const native = createFakeNative();
		const spawns: Array<DetachedSpawn> = [];
		native.addon.spawnDetached = (spawn) => {
			spawns.push(spawn);
			return 900;
		};

		const launch = createSnapshotLightingLauncher(
			createTestSeams({ native: () => native.addon }),
			"/forge/supervisor.mjs",
		);

		expect(
			launch({
				cwd: PROJECT,
				env: { PATH: "tools", UNSET: undefined },
				place: "/snapshot.rbxl",
				studio: { pid: 42, startTime: "42" },
			}),
		).toBe(900);
		expect(spawns).toStrictEqual([
			{
				args: [
					"/forge/supervisor.mjs",
					"--watch-hidden-lighting",
					JSON.stringify({ pid: 42, place: "/snapshot.rbxl", startTime: "42" }),
				],
				cwd: PROJECT,
				env: { PATH: "tools" },
				program: createTestSeams().host.execPath,
			},
		]);
	});

	it.for(["missing", "denied"] as const)("reports a %s detached helper", (kind) => {
		expect.assertions(1);

		const native = createFakeNative();
		const variants = { denied: () => null, missing: undefined };
		Object.assign(native.addon, { spawnDetached: variants[kind] });
		const launch = createSnapshotLightingLauncher(
			createTestSeams({ native: () => native.addon }),
			"/forge/supervisor.mjs",
		);

		expect(() => {
			return launch({
				cwd: PROJECT,
				env: {},
				place: "/snapshot.rbxl",
				studio: { pid: 42, startTime: "42" },
			});
		}).toThrow("The hidden snapshot Lighting watcher could not start.");
	});
});
