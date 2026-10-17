import path from "node:path";
import { assert, describe, it, vi } from "vitest";

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
	const traceFile = path.join(PROJECT, "lighting.jsonl");
	return {
		events: (): Array<unknown> => {
			return seams.fileSystem
				.readFileSync(traceFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		},
		native,
		now: () => now,
		payload: JSON.stringify({ pid: 42, place, startTime: identity }),
		seams,
		studio,
		traceFile,
	};
}

describe("hidden snapshot Lighting watcher", () => {
	it("records startup, native dismissal, and completion for a delayed prompt", async ({
		expect,
	}) => {
		expect.assertions(2);

		const run = watchingSnapshot();
		await runSnapshotLightingAsync(run.seams, run.payload, run.traceFile);
		const events = run.events();

		expect(events.slice(0, 3)).toStrictEqual([
			{
				at: 0,
				event: "start",
				pid: 42,
				place: path.join(PROJECT, "game.rbxl"),
				startTime: "42",
			},
			{ at: 0, deadline: 180_000, event: "opening" },
			{ at: 0, deadline: 30_000, event: "lock" },
		]);
		expect(events.slice(-3)).toStrictEqual([
			{ at: 7000, event: "dismiss-start" },
			{ at: 7000, dismissed: true, event: "dismiss-end" },
			{ at: 7000, event: "end", reason: "dismissed" },
		]);
	});

	it("records a native attempt while it is still pending", async ({ expect }) => {
		expect.assertions(2);

		const run = watchingSnapshot();
		const pending = Promise.withResolvers<boolean>();
		const pin = run.native.addon.pinProcess;
		run.native.addon.pinProcess = (pid) => {
			const pinned = pin(pid);
			assert(pinned !== null);
			return { ...pinned, dismissDialog: async () => pending.promise };
		};

		const watching = runSnapshotLightingAsync(run.seams, run.payload, run.traceFile);

		expect(run.events().at(-1)).toStrictEqual({ at: 0, event: "dismiss-start" });

		pending.resolve(true);
		await watching;

		expect(run.events().at(-1)).toStrictEqual({ at: 0, event: "end", reason: "dismissed" });
	});

	it("records a transient native failure and its successful retry", async ({ expect }) => {
		expect.assertions(2);

		const run = watchingSnapshot();
		const pinned = run.native.addon.pinProcess(42);
		assert(pinned !== null);
		const dismissDialog = vi
			.fn<typeof pinned.dismissDialog>(pinned.dismissDialog)
			.mockRejectedValueOnce(new Error("accessibility is loading"));
		run.native.addon.pinProcess = () => ({ ...pinned, dismissDialog });
		await runSnapshotLightingAsync(run.seams, run.payload, run.traceFile);

		expect(run.events()).toContainEqual({
			at: 0,
			event: "error",
			message: "Error: accessibility is loading",
		});
		expect(run.studio).toMatchObject({ alive: true, blocked: false });
	});

	it("dismisses the prompt even when its diagnostic file cannot be written", async ({
		expect,
	}) => {
		expect.assertions(2);

		const run = watchingSnapshot();
		await runSnapshotLightingAsync(
			run.seams,
			run.payload,
			path.join(PROJECT, "missing", "trace"),
		);

		expect(run.studio).toMatchObject({ alive: true, blocked: false });
		expect(run.now()).toBe(7000);
	});

	it("records a failed polling wait separately from the native attempt", async ({ expect }) => {
		expect.assertions(2);

		const run = watchingSnapshot();
		run.seams.clock.sleep = async () => {
			throw new Error("polling timer failed");
		};

		await runSnapshotLightingAsync(run.seams, run.payload, run.traceFile);

		expect(run.events().slice(-2)).toStrictEqual([
			{ at: 0, dismissed: false, event: "dismiss-end" },
			{ at: 0, event: "end", reason: "sleep-failed" },
		]);
		expect(run.studio.alive).toBeTrue();
	});

	it.for(["gone", "exited"] as const)(
		"ignores a Studio that has %s before its watcher starts",
		async (kind, { expect }) => {
			expect.assertions(1);

			const run = watchingSnapshot();
			const changes = { exited: { exitsAfterPin: true }, gone: { alive: false } };
			Object.assign(run.studio, changes[kind]);
			await runSnapshotLightingAsync(run.seams, run.payload, run.traceFile);

			expect(run.now()).toBe(0);
		},
	);

	it("dismisses a prompt seven seconds after the place lock while leaving other Studios alone", async ({
		expect,
	}) => {
		expect.assertions(3);

		const run = watchingSnapshot();
		await runSnapshotLightingAsync(run.seams, run.payload);

		expect(run.studio).toMatchObject({ alive: true, blocked: false });
		expect(run.native.processes.get(43)).toMatchObject({ alive: true, blocked: true });
		expect(run.now()).toBe(7000);
	});

	it("exits as soon as the launched Studio exits", async ({ expect }) => {
		expect.assertions(2);

		const run = watchingSnapshot({ exits: true });
		await runSnapshotLightingAsync(run.seams, run.payload, run.traceFile);

		expect(run.now()).toBe(500);
		expect(run.events().slice(-2)).toStrictEqual([
			{ at: 500, event: "studio-exited" },
			{ at: 500, event: "end", reason: "cancelled" },
		]);
	});

	it("exits after the bounded opening wait if no place lock appears", async ({ expect }) => {
		expect.assertions(1);

		const run = watchingSnapshot({ hasDialog: false, hasLock: false });
		await runSnapshotLightingAsync(run.seams, run.payload);

		expect(run.now()).toBe(180_000);
	});

	it("exits after the post-lock wait when there is no migration prompt", async ({ expect }) => {
		expect.assertions(2);

		const run = watchingSnapshot({ hasDialog: false });
		await runSnapshotLightingAsync(run.seams, run.payload, run.traceFile);

		expect(run.now()).toBe(30_000);
		expect(run.events().at(-1)).toStrictEqual({ at: 30_000, event: "end", reason: "deadline" });
	});

	it("records when Studio is visible instead of dismissing its prompt", async ({ expect }) => {
		expect.assertions(2);

		const run = watchingSnapshot();
		run.studio.desktop = "user";
		await runSnapshotLightingAsync(run.seams, run.payload, run.traceFile);

		expect(run.events().at(-1)).toStrictEqual({ at: 0, event: "end", reason: "visible" });
		expect(run.now()).toBe(0);
	});

	it("leaves a reused Studio PID untouched", async ({ expect }) => {
		expect.assertions(2);

		const run = watchingSnapshot({ identity: "41" });
		await runSnapshotLightingAsync(run.seams, run.payload);

		expect(run.studio).toMatchObject({ alive: true, blocked: false });
		expect(run.now()).toBe(0);
	});
});

describe("snapshot Lighting helper launch", () => {
	it("starts Node with one exact place identity and a defined environment", ({ expect }) => {
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

	it.for(["missing", "denied"] as const)("reports a %s detached helper", (kind, { expect }) => {
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
