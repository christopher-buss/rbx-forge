import { fromPartial } from "@total-typescript/shoehorn";

import path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { makeStatus, serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { createIdleTracker } from "../session/idle.ts";
import { createPartRequests } from "../session/part-requests.ts";
import { saveSessionStudioAsync } from "../session/session-save.ts";
import { saveStudioAsync } from "../studio/save-studio.ts";
import { runSaveAsync } from "./save.ts";

describe(runSaveAsync, () => {
	it("rejects a malformed session save result", async () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem();
		const ipc = createMemoryTransport();
		const session = await serveFakeSessionAsync(memory, ipc);
		session.save = () => ({ place: "example.rbxl" });
		const context = createCommandContext({
			seams: createTestSeams({ fileSystem: memory.fileSystem, ipc }),
		});

		await expect(runSaveAsync(context, { config: {}, flags: {} })).rejects.toMatchObject({
			code: "internal_error",
		});
	});

	it.for<"missing" | "wrong_pid" | "wrong_process">(["missing", "wrong_pid", "wrong_process"])(
		"refuses the %s place lock even when the session records Studio",
		async (kind) => {
			expect.assertions(1);

			const memory = createMemoryFileSystem({
				"game.rbxl": "place",
				"game.rbxl.lock": `43\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
			});
			const native = createFakeNative({
				42: { alive: true, executablePath: "RobloxStudioBeta.exe" },
				43: {
					alive: true,
					executablePath: {
						missing: "RobloxStudioBeta.exe",
						wrong_pid: "RobloxStudioBeta.exe",
						wrong_process: "another.exe",
					}[kind],
				},
			});
			const locks = {
				missing: "",
				wrong_pid: `43\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
				wrong_process: `43\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
			};
			memory.fileSystem.writeFileSync(path.join(PROJECT, "game.rbxl.lock"), locks[kind]);

			await expect(
				saveStudioAsync(
					createTestSeams({ fileSystem: memory.fileSystem, native: () => native.addon }),
					{
						place: path.join(PROJECT, "game.rbxl"),
						process: { pid: 42, startTime: "42" },
					},
				),
			).rejects.toMatchObject({ code: "studio_not_open" });
		},
	);

	it("reports studio_busy for a modal before saving", async () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem({
			"game.rbxl": "place",
			"game.rbxl.lock": `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
		});
		const native = createFakeNative({
			42: { alive: true, blocked: true, executablePath: "RobloxStudioBeta.exe" },
		});

		await expect(
			saveStudioAsync(
				createTestSeams({ fileSystem: memory.fileSystem, native: () => native.addon }),
				{ place: path.join(PROJECT, "game.rbxl") },
			),
		).rejects.toMatchObject({ code: "studio_busy" });
	});

	it("rejects a zero timeout", async () => {
		expect.assertions(1);

		await expect(
			runSaveAsync(createCommandContext(), { config: {}, flags: { timeout: "0" } }),
		).rejects.toMatchObject({ code: "usage" });
	});

	it("saves a found session Studio one request at a time and resets its idle timeout", async () => {
		expect.assertions(3);

		const memory = createMemoryFileSystem({
			"game.rbxl": "place",
			"game.rbxl.lock": `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
		});
		memory.setModifiedTime("game.rbxl", 1000);
		const manual = createManualClock();
		let mtime = 1000;
		const native = createFakeNative({
			42: {
				alive: true,
				desktop: "hidden",
				executablePath: "RobloxStudioBeta.exe",
				onSave: () => {
					mtime += 1000;
					memory.setModifiedTime("game.rbxl", mtime);
				},
			},
		});
		const ipc = createMemoryTransport();
		const seams = createTestSeams({
			clock: manual.clock,
			fileSystem: memory.fileSystem,
			ipc,
			native: () => native.addon,
		});
		const context = createCommandContext({ seams });
		const session = await serveFakeSessionAsync(memory, ipc);
		session.status.services.studio = {
			origin: "found",
			owner: null,
			pid: 42,
			place: path.join(PROJECT, "game.rbxl"),
			startTime: "42",
			status: "open",
		};
		const idle = createIdleTracker(1, 0);
		const parts = createPartRequests();
		parts.attach(
			fromPartial({
				save: async (timeoutMs: number) => {
					return saveSessionStudioAsync(
						{ context, idle, status: fromPartial({ snapshot: () => session.status }) },
						{ signal: AbortSignal.any([]) },
						timeoutMs,
					);
				},
			}),
		);
		session.save = async ({ timeoutMs }) => ({ ...(await parts.saveAsync(Number(timeoutMs))) });

		const first = runSaveAsync(context, { config: {}, flags: {} });
		const second = runSaveAsync(context, { config: {}, flags: {} });
		for (let tick = 0; tick < 12; tick += 1) {
			await new Promise<void>((resolve) => {
				setImmediate(resolve);
			});
			manual.advance(100);
		}

		const results = await Promise.all([first, second]);

		expect(results.map(({ data }) => data["mtime"])).toStrictEqual([
			"1970-01-01T00:00:02.000Z",
			"1970-01-01T00:00:03.000Z",
		]);
		expect(idle.idleAt()).toBeGreaterThan(60_000);
		expect(results[0].data["desktop"]).toBe("hidden");
	});

	it("waits for an opening Studio before saving", async () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem({
			"game.rbxl": "place",
			"game.rbxl.lock": `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
		});
		memory.setModifiedTime("game.rbxl", 1000);
		let now = 0;
		const status = makeStatus();
		status.services.studio = {
			owner: null,
			pid: 42,
			place: path.join(PROJECT, "game.rbxl"),
			startTime: "42",
			status: "opening",
		};
		const native = createFakeNative({
			42: {
				alive: true,
				executablePath: "RobloxStudioBeta.exe",
				onSave: () => {
					memory.setModifiedTime("game.rbxl", 2000);
				},
			},
		});
		const seams = createTestSeams({
			clock: {
				now: () => now,
				sleep: async (ms) => {
					now += ms;
					status.services.studio.status = "open";
				},
			},
			fileSystem: memory.fileSystem,
			native: () => native.addon,
		});
		const result = await saveSessionStudioAsync(
			{
				context: createCommandContext({ seams }),
				idle: createIdleTracker(1, 0),
				status: fromPartial({ snapshot: () => status }),
			},
			{ signal: AbortSignal.any([]) },
			1000,
		);

		expect(result).toMatchObject({ durationMs: 400, mtime: "1970-01-01T00:00:02.000Z" });
	});

	it("reports studio_not_open when no session owns a Studio", async () => {
		expect.assertions(1);

		await expect(
			runSaveAsync(createCommandContext(), { config: {}, flags: {} }),
		).rejects.toMatchObject({ code: "studio_not_open" });
	});

	it("returns a saved place only after its changed mtime settles", async () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem({
			"game.rbxl": "place",
			"game.rbxl.lock": `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
		});
		memory.setModifiedTime("game.rbxl", 1000);
		const native = createFakeNative({
			42: {
				alive: true,
				executablePath: "RobloxStudioBeta.exe",
				onSave: () => {
					memory.setModifiedTime("game.rbxl", 2000);
				},
			},
		});
		const manual = createManualClock();
		const seams = createTestSeams({
			clock: manual.clock,
			fileSystem: memory.fileSystem,
			native: () => native.addon,
		});
		const saving = saveStudioAsync(
			seams,
			{
				desktop: "user",
				place: path.join(PROJECT, "game.rbxl"),
				process: { pid: 42, startTime: "42" },
			},
			1000,
		);
		manual.advance(250);
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});
		manual.advance(250);

		await expect(saving).resolves.toStrictEqual({
			bytes: 5,
			desktop: "user",
			durationMs: 500,
			mtime: "1970-01-01T00:00:02.000Z",
			pid: 42,
			place: path.join(PROJECT, "game.rbxl"),
		});
	});

	it.for<"dialog" | "ignore" | "no_menu_item" | "throw">([
		"dialog",
		"no_menu_item",
		"ignore",
		"throw",
	])("reports the %s save outcome", async (mode) => {
		expect.assertions(1);

		const memory = createMemoryFileSystem({
			"game.rbxl": "place",
			"game.rbxl.lock": `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
		});
		const native = createFakeNative({
			42: { alive: true, executablePath: "RobloxStudioBeta.exe", onSaveRequest: mode },
		});
		let now = 0;
		const seams = createTestSeams({
			clock: {
				now: () => now,
				sleep: async (ms) => {
					now += ms;
				},
			},
			fileSystem: memory.fileSystem,
			native: () => native.addon,
		});
		const reasons = {
			dialog: "studio_error",
			ignore: "timeout",
			no_menu_item: "no_menu_item",
			throw: "studio_error",
		};

		await expect(
			saveStudioAsync(
				seams,
				{
					place: path.join(PROJECT, "game.rbxl"),
					process: { pid: 42, startTime: "42" },
				},
				1000,
			),
		).rejects.toMatchObject({ code: "save_failed", details: { reason: reasons[mode] } });
	});

	it("refuses a read-only place before Studio can show a save dialog", async () => {
		expect.assertions(2);

		const memory = createMemoryFileSystem({
			"game.rbxl": "place",
			"game.rbxl.lock": `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
		});
		memory.setMode("game.rbxl", 0o444);
		const native = createFakeNative({
			42: { alive: true, executablePath: "RobloxStudioBeta.exe", onSaveRequest: "dialog" },
		});
		const seams = createTestSeams({
			fileSystem: memory.fileSystem,
			native: () => native.addon,
		});

		await expect(
			saveStudioAsync(seams, {
				place: path.join(PROJECT, "game.rbxl"),
				process: { pid: 42, startTime: "42" },
			}),
		).rejects.toMatchObject({ code: "save_failed", details: { reason: "permission_denied" } });
		expect(native.processes.get(42)!.blocked).toBeUndefined();
	});
});
