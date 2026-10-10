import { fromPartial } from "@total-typescript/shoehorn";

import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { createStatusStore } from "./status.ts";
import { createStudioMover } from "./studio-move.ts";

function fixture(platform: "darwin" | "win32", hidden = false) {
	const memory = createMemoryFileSystem({
		"game.rbxl": "unsaved bytes stay off disk",
		"game.rbxl.lock": `777\nRobloxStudio\n${TEST_HOSTNAME}\n`,
	});
	const save = vi.fn<() => void>(() => {
		memory.fileSystem.writeFileSync(path.join(PROJECT, "game.rbxl"), "saved");
	});
	memory.setMode(path.join(PROJECT, "game.rbxl"), 0o444);
	const native = createFakeNative({
		777: {
			alive: true,
			appHidden: hidden,
			desktop: "user",
			executablePath: "/opt/RobloxStudio",
			onSave: save,
			startTime: "0",
			windowHiding: hidden,
			windowVisibility: hidden ? "hidden" : "user",
		},
	});
	const seams = createTestSeams({ fileSystem: memory.fileSystem, native: () => native.addon });
	seams.host.platform = platform;
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
		() => 0,
		() => {},
	);
	status.studio(
		"open",
		path.join(PROJECT, "game.rbxl"),
		{ desktop: hidden ? "hidden" : "user", pid: 777, startTime: "0" },
		"found",
	);
	status.service("rojo", "ready");
	status.started();
	const abort = new AbortController();
	const move = createStudioMover(
		fromPartial({
			context: createCommandContext({ seams }),
			idle: { activity: () => {} },
			status,
		}),
		fromPartial({ signal: abort.signal }),
	);
	return { abort, memory, move, native, save, seams, status };
}

describe("session Studio visibility", () => {
	it.for(["darwin", "win32"] as const)(
		"hides and shows the same %s Studio without saving or replacing its parts",
		async (platform) => {
			expect.assertions(5);

			const { memory, move, save, status } = fixture(platform);

			await expect(move({ desktop: "hidden" })).resolves.toMatchObject({
				from: "user",
				pid: 777,
				to: "hidden",
			});
			await expect(move({ desktop: "user" })).resolves.toMatchObject({
				from: "hidden",
				pid: 777,
				to: "user",
			});
			expect(save).not.toHaveBeenCalled();
			expect(memory.fileSystem.readFileSync(path.join(PROJECT, "game.rbxl"), "utf8")).toBe(
				"unsaved bytes stay off disk",
			);
			expect(status.snapshot().services).toMatchObject({
				rojo: { owner: "start", status: "ready" },
				studio: {
					desktop: "user",
					origin: "found",
					owner: "start",
					pid: 777,
					status: "open",
				},
			});
		},
	);

	it.for([
		{ desktop: "hidden", platform: "darwin" },
		{ desktop: "user", platform: "darwin" },
		{ desktop: "hidden", platform: "win32" },
		{ desktop: "user", platform: "win32" },
	] as const)(
		"leaves an already requested $platform $desktop visibility unchanged",
		async ({ desktop, platform }) => {
			expect.assertions(3);

			const { move, native } = fixture(platform, desktop === "hidden");
			const pin = native.addon.pinProcess;
			const change = vi.fn<() => boolean>(() => false);
			native.addon.pinProcess = (pid) => {
				const pinned = pin(pid);
				assert(pinned !== null);
				return { ...pinned, setAppHidden: change, setWindowVisibility: change };
			};

			await expect(move({ desktop })).resolves.toStrictEqual({
				durationMs: 0,
				from: desktop,
				pid: 777,
				to: desktop,
			});
			await expect(move({ desktop })).resolves.toStrictEqual({
				durationMs: 0,
				from: desktop,
				pid: 777,
				to: desktop,
			});
			expect(change).not.toHaveBeenCalled();
		},
	);

	it("starts the Windows re-hide watcher on hide and stops it on show", async () => {
		expect.assertions(2);

		const { move, native } = fixture("win32");
		await move({ desktop: "hidden" });

		expect(native.processes.get(777)!.windowHiding).toBeTrue();

		await move({ desktop: "user" });

		expect(native.processes.get(777)!.windowHiding).toBeFalse();
	});

	it("keeps already hidden Windows windows hidden with a watcher", async () => {
		expect.assertions(4);

		const { move, native } = fixture("win32", true);
		native.processes.get(777)!.windowHiding = false;

		await expect(move({ desktop: "hidden" })).resolves.toMatchObject({
			from: "hidden",
			pid: 777,
			to: "hidden",
		});
		expect(native.processes.get(777)!.windowHiding).toBeTrue();
		await expect(move({ desktop: "hidden" })).resolves.toMatchObject({
			from: "hidden",
			pid: 777,
			to: "hidden",
		});
		expect(native.processes.get(777)!.windowHiding).toBeTrue();
	});

	it("retries the Windows watcher after hiding succeeds but its watcher fails", async () => {
		expect.assertions(4);

		const { move, native } = fixture("win32");
		const pin = native.addon.pinProcess;
		const pinned = pin(777);
		assert(pinned !== null);
		const start = vi.fn<() => boolean>(pinned.startWindowHiding).mockReturnValueOnce(false);
		native.addon.pinProcess = (pid) => {
			const current = pin(pid);
			assert(current !== null);
			return { ...current, startWindowHiding: start };
		};

		await expect(move({ desktop: "hidden" })).rejects.toMatchObject({
			code: "studio_launch_failed",
		});
		expect(native.processes.get(777)!.windowVisibility).toBe("hidden");
		await expect(move({ desktop: "hidden" })).resolves.toMatchObject({
			from: "hidden",
			pid: 777,
			to: "hidden",
		});
		expect(native.processes.get(777)!.windowHiding).toBeTrue();
	});

	it.for(["darwin", "win32"] as const)(
		"retains %s visibility when cancelled",
		async (platform) => {
			expect.assertions(2);

			const { abort, move, native } = fixture(platform);
			abort.abort();

			await expect(move({ desktop: "hidden" })).rejects.toMatchObject({ name: "AbortError" });
			expect(native.processes.get(777)).toMatchObject({
				appHidden: false,
				windowVisibility: "user",
			});
		},
	);

	it.for(["darwin", "win32"] as const)(
		"rejects a reused %s Studio identity",
		async (platform) => {
			expect.assertions(1);

			const { move, native } = fixture(platform);
			native.processes.get(777)!.startTime = "99";

			await expect(move({ desktop: "hidden" })).rejects.toMatchObject({
				code: "studio_not_open",
			});
		},
	);

	it.for(["stopped", "stopping"] as const)("rejects a %s session", async (phase) => {
		expect.assertions(1);

		const { move, status } = fixture("win32");
		const snapshot = status.snapshot();
		vi.spyOn(status, "snapshot").mockReturnValue({ ...snapshot, phase });

		await expect(move({ desktop: "hidden" })).rejects.toMatchObject({ code: "not_running" });
	});

	it.for(["opening", "closed"] as const)("rejects a Studio that is %s", async (studioStatus) => {
		expect.assertions(1);

		const { move, status } = fixture("win32");
		const snapshot = status.snapshot();
		vi.spyOn(status, "snapshot").mockReturnValue({
			...snapshot,
			services: {
				...snapshot.services,
				studio: { ...snapshot.services.studio, status: studioStatus },
			},
		});

		await expect(move({ desktop: "hidden" })).rejects.toMatchObject({
			code: "studio_not_open",
		});
	});

	it("requires the session's place and PID", async () => {
		expect.assertions(2);

		const { move, status } = fixture("win32");
		const snapshot = status.snapshot();
		const studio = { ...snapshot.services.studio };
		delete studio.place;
		vi.spyOn(status, "snapshot").mockReturnValue({
			...snapshot,
			services: { ...snapshot.services, studio },
		});

		await expect(move({ desktop: "hidden" })).rejects.toMatchObject({
			code: "studio_not_open",
		});

		vi.mocked(status.snapshot).mockReturnValue({
			...snapshot,
			services: { ...snapshot.services, studio: { ...snapshot.services.studio, pid: 888 } },
		});

		await expect(move({ desktop: "hidden" })).rejects.toMatchObject({
			code: "studio_not_open",
		});
	});

	it("rejects a session whose Studio has released the place", async () => {
		expect.assertions(1);

		const { memory, move } = fixture("win32");
		memory.fileSystem.rmSync(path.join(PROJECT, "game.rbxl.lock"));

		await expect(move({ desktop: "hidden" })).rejects.toMatchObject({
			code: "studio_not_open",
		});
	});

	it("accepts older status without a recorded start time", async () => {
		expect.assertions(1);

		const { move, status } = fixture("win32");
		const snapshot = status.snapshot();
		const studio = { ...snapshot.services.studio };
		delete studio.startTime;
		vi.spyOn(status, "snapshot").mockReturnValue({
			...snapshot,
			services: { ...snapshot.services, studio },
		});

		await expect(move({ desktop: "hidden" })).resolves.toMatchObject({
			pid: 777,
			to: "hidden",
		});
	});

	it.for(["missing", "reused", "cancelled"] as const)(
		"rejects a pin %s after its place identity was checked",
		async (change) => {
			expect.assertions(1);

			const { abort, move, native } = fixture("win32");
			const pin = native.addon.pinProcess;
			const pinned = pin(777);
			assert(pinned !== null);
			const changed = {
				cancelled: pinned,
				missing: null,
				reused: { ...pinned, startTime: "99" },
			};
			vi.spyOn(native.addon, "pinProcess")
				.mockImplementation(pin)
				.mockImplementationOnce(pin)
				.mockImplementationOnce(() => {
					const actions = {
						cancelled: () => {
							abort.abort();
						},
						missing: () => {},
						reused: () => {},
					};
					actions[change]();
					return changed[change];
				});

			await expect(move({ desktop: "hidden" })).rejects.toMatchObject(
				{
					cancelled: { name: "AbortError" },
					missing: { code: "studio_not_open" },
					reused: { code: "studio_not_open" },
				}[change],
			);
		},
	);

	it.for(["darwin", "win32"] as const)("rejects unavailable %s visibility", async (platform) => {
		expect.assertions(1);

		const { move, native } = fixture(platform);
		native.processes.get(777)!.appHidden = null;
		native.processes.get(777)!.windowVisibility = null;

		await expect(move({ desktop: "hidden" })).rejects.toMatchObject({
			code: "studio_not_open",
		});
	});

	it.for(["darwin", "win32"] as const)(
		"retains status when %s refuses a visibility change",
		async (platform) => {
			expect.assertions(2);

			const { move, native, status } = fixture(platform);
			const pin = native.addon.pinProcess;
			native.addon.pinProcess = (pid) => {
				const pinned = pin(pid);
				assert(pinned !== null);
				return { ...pinned, setAppHidden: () => false, setWindowVisibility: () => false };
			};

			await expect(move({ desktop: "hidden" })).rejects.toMatchObject({
				code: "studio_launch_failed",
			});
			expect(status.snapshot().services.studio.desktop).toBe("user");
		},
	);

	it("reports a Windows re-hide watcher failure", async () => {
		expect.assertions(1);

		const { move, native } = fixture("win32");
		const pin = native.addon.pinProcess;
		native.addon.pinProcess = (pid) => {
			const pinned = pin(pid);
			assert(pinned !== null);
			return { ...pinned, startWindowHiding: () => false };
		};

		await expect(move({ desktop: "hidden" })).rejects.toMatchObject({
			code: "studio_launch_failed",
		});
	});
});
