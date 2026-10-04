import { fromPartial } from "@total-typescript/shoehorn";

import path from "node:path";
import { describe, expect, it } from "vitest";

import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { resolveConfig } from "../config/resolve.ts";
import { createStatusStore } from "./status.ts";
import { createStudioMover } from "./studio-move.ts";

function fixture(
	hidden = false,
	{ abortAfterSave = false, missingStart = false, reuseAfterLookup = false } = {},
) {
	let now = 0;
	let savedPins = 0;
	let hasSaved = false;
	let activities = 0;
	const abort = new AbortController();
	const place = path.join(PROJECT, "game.rbxl");
	const memory = createMemoryFileSystem({
		"game.rbxl": "edits",
		"game.rbxl.lock": `777\nRobloxStudio\n${TEST_HOSTNAME}\n`,
	});
	memory.setModifiedTime("game.rbxl", 1000);
	const executablePath = "/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio";
	const native = createFakeNative({
		777: {
			alive: true,
			appHidden: hidden,
			desktop: "user",
			executablePath,
			onSave: () => {
				memory.setModifiedTime(
					"game.rbxl",
					memory.fileSystem.statSync(place).mtimeMs + 1000,
				);
			},
			startTime: "0",
		},
		888: { alive: true, appHidden: false, executablePath },
	});
	const seams = createTestSeams();
	const { pinProcess } = native.addon;
	native.addon.pinProcess = (pid) => {
		if (hasSaved) {
			savedPins++;
		}

		if (reuseAfterLookup && hasSaved && savedPins === 2) {
			native.processes.get(777)!.startTime = "99";
		}

		return pinProcess(pid);
	};

	const context = createCommandContext({
		seams: createTestSeams({
			clock: {
				now: () => now,
				sleep: async (ms) => {
					now += ms;
				},
			},
			fileSystem: memory.fileSystem,
			host: { ...seams.host, platform: "darwin" },
			native: () => native.addon,
		}),
	});
	const status = createStatusStore(
		{
			compiler: true,
			open: true,
			owner: "start",
			pid: 1,
			port: 34872,
			sessionId: "test",
			startedAt: "1970-01-01T00:00:00Z",
			syncback: false,
		},
		() => now,
		() => {},
	);
	status.studio("open", place, { desktop: "user", pid: 777, startTime: "0" }, "forge");
	status.service("compiler", "ready");
	status.service("rojo", "ready");
	status.started();
	const move = createStudioMover(
		fromPartial({
			config: resolveConfig({ projectType: "luau" }, {}),
			context,
			idle: {
				activity: () => {
					activities++;
					if (activities !== 2) {
						return;
					}

					hasSaved = true;
					if (abortAfterSave) {
						abort.abort();
					}
				},
			},
			status: {
				...status,
				snapshot: () => {
					const snapshot = status.snapshot();
					if (!missingStart) {
						return snapshot;
					}

					const studio = { ...snapshot.services.studio };
					delete studio.startTime;
					return { ...snapshot, services: { ...snapshot.services, studio } };
				},
			},
		}),
		fromPartial({ signal: abort.signal }),
		fromPartial({ state: { isAttached: true } }),
	);
	return { memory, move, native, place, status };
}

describe("macOS Studio visibility", () => {
	it("leaves visibility and status unchanged when AppKit refuses the change", async () => {
		expect.assertions(3);

		const { move, native, status } = fixture();
		native.processes.get(777)!.refusesAppVisibility = true;

		await expect(move({ desktop: "hidden", timeoutMs: 30_000 })).rejects.toMatchObject({
			code: "studio_launch_failed",
			message: "Studio could not change its app visibility.",
		});
		expect(native.processes.get(777)).toMatchObject({ alive: true, appHidden: false });
		expect(status.snapshot().services.studio).toMatchObject({ desktop: "user", pid: 777 });
	});

	it("rejects an app that disappears after its place was saved", async () => {
		expect.assertions(1);

		const { move, native } = fixture();
		native.processes.get(777)!.appHidden = null;

		await expect(move({ desktop: "hidden", timeoutMs: 30_000 })).rejects.toMatchObject({
			code: "studio_not_open",
			message: "The saved Studio app is no longer open.",
		});
	});

	it("does not hide a PID whose Studio identity changed while saving", async () => {
		expect.assertions(2);

		const { memory, move, native } = fixture();
		const process = native.processes.get(777)!;
		process.onSave = () => {
			memory.setModifiedTime("game.rbxl", 2000);
			process.startTime = "99";
		};

		await expect(move({ desktop: "hidden", timeoutMs: 30_000 })).rejects.toMatchObject({
			code: "studio_not_open",
			message: "The saved Studio is no longer open.",
		});
		expect(native.processes.get(777)).toMatchObject({ alive: true, appHidden: false });
	});

	it("rejects a reused PID between checking the saved place and pinning its app", async () => {
		expect.assertions(2);

		const { move, native } = fixture(false, { reuseAfterLookup: true });

		await expect(move({ desktop: "hidden", timeoutMs: 30_000 })).rejects.toMatchObject({
			code: "studio_not_open",
			message: "The saved Studio is no longer open.",
		});
		expect(native.processes.get(777)).toMatchObject({ alive: true, appHidden: false });
	});

	it("moves a verified app when older session status lacks its start time", async () => {
		expect.assertions(1);

		const { move } = fixture(false, { missingStart: true });

		await expect(move({ desktop: "hidden", timeoutMs: 30_000 })).resolves.toMatchObject({
			from: "user",
			pid: 777,
			to: "hidden",
		});
	});

	it("retains app visibility when cancelled after saving", async () => {
		expect.assertions(2);

		const { move, native } = fixture(false, { abortAfterSave: true });

		await expect(move({ desktop: "hidden", timeoutMs: 30_000 })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(native.processes.get(777)).toMatchObject({ alive: true, appHidden: false });
	});

	it("saves an already hidden app without requesting another visibility change", async () => {
		expect.assertions(1);

		const { move, native } = fixture(true);
		native.processes.get(777)!.refusesAppVisibility = true;

		await expect(move({ desktop: "hidden", timeoutMs: 30_000 })).resolves.toMatchObject({
			from: "hidden",
			pid: 777,
			save: { desktop: "user", pid: 777 },
			to: "hidden",
		});
	});

	it("shows an app hidden outside forge even when the status still records user", async () => {
		expect.assertions(3);

		const { move, native, status } = fixture(true);

		await expect(move({ desktop: "user", timeoutMs: 30_000 })).resolves.toMatchObject({
			from: "hidden",
			pid: 777,
			save: { desktop: "user", pid: 777 },
			to: "user",
		});
		expect(native.processes.get(777)).toMatchObject({ alive: true, appHidden: false });
		expect(status.snapshot().services.studio).toMatchObject({ desktop: "user", pid: 777 });
	});

	it.for([false, true])(
		"leaves app visibility and PID unchanged when saving a read-only place",
		async (hidden) => {
			expect.assertions(3);

			const { memory, move, native, place, status } = fixture(hidden);
			memory.setMode(place, 0o444);

			await expect(move({ desktop: "hidden", timeoutMs: 30_000 })).rejects.toMatchObject({
				code: "save_failed",
				details: { reason: "permission_denied" },
			});
			expect(native.processes.get(777)).toMatchObject({ alive: true, appHidden: hidden });
			expect(status.snapshot().services.studio).toMatchObject({ desktop: "user", pid: 777 });
		},
	);

	it("saves and hides only the session Studio while retaining its PID and parts", async () => {
		expect.assertions(4);

		const { move, native, status } = fixture();

		await expect(move({ desktop: "hidden", timeoutMs: 30_000 })).resolves.toMatchObject({
			from: "user",
			pid: 777,
			save: { desktop: "user", pid: 777 },
			to: "hidden",
		});
		expect(native.processes.get(777)).toMatchObject({ alive: true, appHidden: true });
		expect(native.processes.get(888)).toMatchObject({ alive: true, appHidden: false });
		expect(status.snapshot().services).toMatchObject({
			compiler: { owner: "start", status: "ready" },
			rojo: { owner: "start", port: 34872, status: "ready" },
			studio: {
				desktop: "hidden",
				origin: "forge",
				owner: "start",
				pid: 777,
				status: "open",
			},
		});
	});
});
