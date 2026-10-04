import { fromPartial } from "@total-typescript/shoehorn";

import path from "node:path";
import { assert, describe, expect, it } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { makeStatus, serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import type { IpcConnection } from "../ipc/connection.ts";
import type { FileSystem } from "../seams/file-system.ts";
import { createIdleTracker } from "../session/idle.ts";
import { saveSessionStudioAsync } from "../session/session-save.ts";
import { saveStudioAsync } from "../studio/save-studio.ts";
import { runSaveAsync } from "./save.ts";

const PLACE = path.join(PROJECT, "game.rbxl");

function delayedSaveFailure(responseAfterMs: number): IpcConnection {
	return {
		close: () => {},
		readLineAsync: async (timeoutMs) => {
			if (timeoutMs < responseAfterMs) {
				return { type: "timed_out" };
			}

			return {
				line: JSON.stringify({
					error: {
						code: "save_failed",
						details: { reason: "timeout" },
						message: "Studio did not save before the timeout.",
					},
					ok: false,
					type: "response",
				}),
				type: "line",
			};
		},
		writeAsync: async () => true,
	};
}

function withOneDescriptor(fileSystem: FileSystem): FileSystem {
	const held = new Set<number>();
	return {
		...fileSystem,
		closeSync: (descriptor) => {
			fileSystem.closeSync(descriptor);
			held.delete(descriptor);
		},
		openSync: (...parameters) => {
			if (held.size > 0) {
				throw new Error("EMFILE: too many open files");
			}

			const descriptor = fileSystem.openSync(...parameters);
			held.add(descriptor);
			return descriptor;
		},
	};
}

function saveProject() {
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
	let now = 5000;
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
	return { memory, native, seams };
}

describe("save validation", () => {
	it("shares the save deadline with hidden dialog inspection", async () => {
		expect.assertions(2);

		const { native, seams } = saveProject();
		const studio = native.processes.get(42);
		assert(studio !== undefined);
		studio.desktop = "hidden";
		const pin = native.addon.pinProcess;
		native.addon.pinProcess = (pid) => {
			const pinned = pin(pid);
			assert(pinned !== null);
			return {
				...pinned,
				dismissDialog: async (_title, _button, _desktop, timeoutMs = 1000) => {
					await seams.clock.sleep(timeoutMs);
					return false;
				},
			};
		};

		await expect(saveStudioAsync(seams, { place: PLACE }, 1000)).rejects.toMatchObject({
			code: "save_failed",
			details: { reason: "timeout" },
		});
		expect(seams.clock.now()).toBe(6000);
	});

	it("refuses another recorded PID even when its start time matches the place Studio", async () => {
		expect.assertions(1);

		const { seams } = saveProject();

		await expect(
			saveStudioAsync(seams, { place: PLACE, process: { pid: 43, startTime: "42" } }),
		).rejects.toMatchObject({
			code: "studio_not_open",
			message: `Roblox Studio does not have ${PLACE} open.`,
		});
	});

	it("gives the native save only the time remaining in the requested deadline", async () => {
		expect.assertions(2);

		const { native, seams } = saveProject();
		const pin = native.addon.pinProcess;
		native.addon.pinProcess = (pid) => {
			const pinned = pin(pid);
			assert(pinned !== null);
			return {
				...pinned,
				requestSave: async (timeoutMs = 30_000) => {
					await seams.clock.sleep(timeoutMs);
					return "timeout";
				},
			};
		};

		await expect(saveStudioAsync(seams, { place: PLACE }, 1000)).rejects.toMatchObject({
			code: "save_failed",
			details: { reason: "timeout" },
		});
		expect(seams.clock.now()).toBe(6000);
	});

	it("allows time for a session to report its save deadline rather than treating it as unresponsive", async () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem();
		const ipc = createMemoryTransport();
		await serveFakeSessionAsync(memory, ipc);
		const context = createCommandContext({
			seams: createTestSeams({
				fileSystem: memory.fileSystem,
				ipc: { ...ipc, connectAsync: async () => delayedSaveFailure(1250) },
			}),
		});

		await expect(
			runSaveAsync(context, { config: {}, flags: { timeout: "1" } }),
		).rejects.toMatchObject({
			code: "save_failed",
			details: { reason: "timeout" },
		});
	});

	it("saves a visible Studio even when hidden dialog automation is unavailable", async () => {
		expect.assertions(1);

		const { native, seams } = saveProject();
		const pin = native.addon.pinProcess;
		native.addon.pinProcess = (pid) => {
			const pinned = pin(pid);
			assert(pinned !== null);
			return {
				...pinned,
				dismissDialog: async () => {
					throw new Error("hidden dialog automation is unavailable");
				},
			};
		};

		await expect(saveStudioAsync(seams, { place: PLACE })).resolves.toMatchObject({
			desktop: "user",
			durationMs: 300,
			mtime: "1970-01-01T00:00:02.000Z",
		});
	});

	it("can save repeatedly with a single available file descriptor", async () => {
		expect.assertions(2);

		const { memory, native, seams } = saveProject();
		seams.fileSystem = withOneDescriptor(seams.fileSystem);
		const context = createCommandContext({ seams });
		const input = { config: {}, flags: { place: "game.rbxl" } };

		await expect(runSaveAsync(context, input)).resolves.toMatchObject({
			data: { mtime: "1970-01-01T00:00:02.000Z" },
		});

		const studio = native.processes.get(42);
		assert(studio !== undefined);
		studio.onSave = () => {
			memory.setModifiedTime("game.rbxl", 3000);
		};

		await expect(runSaveAsync(context, input)).resolves.toMatchObject({
			data: { mtime: "1970-01-01T00:00:03.000Z" },
		});
	});

	it("stops polling at a fractional deadline while a written place is still settling", async () => {
		expect.assertions(2);

		const { seams } = saveProject();

		await expect(saveStudioAsync(seams, { place: PLACE }, 240)).rejects.toMatchObject({
			code: "save_failed",
			details: { place: PLACE, reason: "timeout" },
			message: `Could not save ${PLACE}: timeout.`,
		});
		expect(seams.clock.now()).toBe(5240);
	});

	it("refuses a reused PID between checking the lock and pinning the save", async () => {
		expect.assertions(1);

		const { native, seams } = saveProject();
		const checked = native.addon.pinProcess(42);
		assert(checked !== null);
		const pins = [checked, { ...checked, startTime: "reused" }];
		native.addon.pinProcess = () => {
			const pinned = pins.shift();
			assert(pinned !== undefined);
			return pinned;
		};

		await expect(saveStudioAsync(seams, { place: PLACE })).rejects.toMatchObject({
			code: "studio_not_open",
			message: `Roblox Studio does not have ${PLACE} open.`,
		});
	});

	it("does not save when Studio exits after its lock was checked", async () => {
		expect.assertions(1);

		const { native, seams } = saveProject();
		const checked = native.addon.pinProcess(42);
		assert(checked !== null);
		const pins = [checked, { ...checked, isAlive: () => false }];
		native.addon.pinProcess = () => {
			const pinned = pins.shift();
			assert(pinned !== undefined);
			return pinned;
		};

		await expect(saveStudioAsync(seams, { place: PLACE })).rejects.toMatchObject({
			code: "studio_not_open",
			message: `Roblox Studio does not have ${PLACE} open.`,
		});
	});

	it("leaves no extra save time after Studio finishes opening", async () => {
		expect.assertions(2);

		const { native, seams } = saveProject();
		const studio = native.processes.get(42);
		assert(studio !== undefined);
		studio.onSaveRequest = "ignore";
		const session = makeStatus();
		session.services.studio = {
			owner: null,
			pid: 42,
			place: PLACE,
			startTime: "42",
			status: "opening",
		};
		const { sleep } = seams.clock;
		seams.clock.sleep = async (ms, signal) => {
			await sleep(ms, signal);
			session.services.studio.status = "open";
		};

		const idle = createIdleTracker(1, 0);

		await expect(
			saveSessionStudioAsync(
				{
					context: createCommandContext({ seams }),
					idle,
					status: fromPartial({ snapshot: () => session }),
				},
				{ signal: AbortSignal.any([]) },
				1000,
			),
		).rejects.toMatchObject({ code: "save_failed", details: { reason: "timeout" } });
		expect(idle.idleAt()).toBe(66_000);
	});

	it("reports the invalid command timeout and guidance for a missing session", async () => {
		expect.assertions(2);

		await expect(
			runSaveAsync(createCommandContext(), { config: {}, flags: { timeout: "NaN" } }),
		).rejects.toMatchObject({
			code: "usage",
			message: "--timeout must be a positive number of seconds.",
		});
		await expect(
			runSaveAsync(createCommandContext(), { config: {}, flags: {} }),
		).rejects.toMatchObject({
			code: "studio_not_open",
			hint: 'Open one with "forge up --studio".',
			message: "No session Studio is open.",
		});
	});

	it("uses seconds for a command deadline and reports the saved Studio", async () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem();
		const ipc = createMemoryTransport();
		const session = await serveFakeSessionAsync(memory, ipc);
		session.save = ({ timeoutMs }) => {
			return {
				bytes: 5,
				desktop: "hidden",
				durationMs: timeoutMs,
				mtime: "1970-01-01T00:00:02.000Z",
				pid: 42,
				place: PLACE,
			};
		};

		await expect(
			runSaveAsync(
				createCommandContext({
					seams: createTestSeams({ fileSystem: memory.fileSystem, ipc }),
				}),
				{ config: {}, flags: { timeout: "1.234" } },
			),
		).resolves.toStrictEqual({
			data: {
				bytes: 5,
				desktop: "hidden",
				durationMs: 1234,
				mtime: "1970-01-01T00:00:02.000Z",
				pid: 42,
				place: PLACE,
			},
			summary: `Saved ${PLACE} in Roblox Studio (PID 42, desktop hidden).`,
		});
	});

	it("reports malformed save metadata with its stable error message", async () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem();
		const ipc = createMemoryTransport();
		const session = await serveFakeSessionAsync(memory, ipc);
		session.save = () => ({});

		await expect(
			runSaveAsync(
				createCommandContext({
					seams: createTestSeams({ fileSystem: memory.fileSystem, ipc }),
				}),
				{ config: {}, flags: {} },
			),
		).rejects.toMatchObject({
			code: "internal_error",
			message: "The session answered save with something else.",
		});
	});

	it("saves an open session Studio with no recorded process identity", async () => {
		expect.assertions(2);

		const { seams } = saveProject();
		const session = makeStatus();
		session.services.studio = { owner: null, place: PLACE, status: "open" };
		const idle = createIdleTracker(1, 0);

		await expect(
			saveSessionStudioAsync(
				{
					context: createCommandContext({ seams }),
					idle,
					status: fromPartial({ snapshot: () => session }),
				},
				{ signal: AbortSignal.any([]) },
				1000,
			),
		).resolves.toMatchObject({ durationMs: 300, pid: 42 });
		expect(idle.idleAt()).toBe(65_300);
	});

	it("refuses the same Studio PID when its recorded start time differs", async () => {
		expect.assertions(1);

		const { seams } = saveProject();

		await expect(
			saveStudioAsync(seams, { place: PLACE, process: { pid: 42, startTime: "old" } }),
		).rejects.toMatchObject({
			code: "studio_not_open",
			message: `Roblox Studio does not have ${PLACE} open.`,
		});
	});

	it("refuses a Studio that disappears before the save can pin it", async () => {
		expect.assertions(1);

		const { native, seams } = saveProject();
		const pins = [native.addon.pinProcess(42), null];
		native.addon.pinProcess = () => {
			const pinned = pins.shift();
			assert(pinned !== undefined);
			return pinned;
		};

		await expect(saveStudioAsync(seams, { place: PLACE })).rejects.toMatchObject({
			code: "studio_not_open",
			message: `Roblox Studio does not have ${PLACE} open.`,
		});
	});

	it("reports a read-only place even when its writable open succeeds", async () => {
		expect.assertions(1);

		const { memory, seams } = saveProject();
		memory.setMode("game.rbxl", 0o444);
		seams.fileSystem = { ...seams.fileSystem, closeSync: () => {}, openSync: () => 7 };

		await expect(saveStudioAsync(seams, { place: PLACE })).rejects.toMatchObject({
			cause: { message: "The place is read-only." },
			code: "save_failed",
			details: { place: PLACE, reason: "permission_denied" },
			message: `Could not save ${PLACE}: permission_denied.`,
		});
	});

	it("reports a modal dialog with its stable message", async () => {
		expect.assertions(1);

		const { native, seams } = saveProject();
		const studio = native.processes.get(42);
		assert(studio !== undefined);
		studio.blocked = true;

		await expect(saveStudioAsync(seams, { place: PLACE })).rejects.toMatchObject({
			code: "studio_busy",
			message: "A modal dialog blocks Roblox Studio.",
		});
	});
});
