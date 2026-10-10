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
import { createIdleTracker } from "./idle.ts";
import { createOwnerHandlers } from "./ownership.ts";
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
	const idle = createIdleTracker(1, 0);
	const move = createStudioMover(
		fromPartial({
			context: createCommandContext({ seams }),
			idle,
			status,
		}),
		fromPartial({ signal: abort.signal }),
	);
	return { abort, idle, memory, move, native, save, seams, status };
}

describe("session Studio visibility", () => {
	it.for([
		{ platform: "win32", visible: { windowHiding: false, windowVisibility: "user" } },
		{ platform: "darwin", visible: { appHidden: false } },
	] as const)(
		"start shows the same hidden Studio on $platform without saving and gives it back shown",
		async ({ platform, visible }) => {
			expect.assertions(4);

			const { memory, move, native, save, status } = fixture(platform, true);
			status.owner("studio", null);
			status.owner("rojo", null);
			const handlers = createOwnerHandlers(
				{ status },
				{ end: () => {} },
				{
					add: async () => [],
					move,
					ownership: { added: new Set(), isOwned: false },
					parts: { stopAsync: async () => {} },
					studio: { isAttached: true },
					waitForStudio: async () => {},
				},
			);
			await handlers.own({ defaultDesktop: "user", parts: ["studio"] });

			expect(status.snapshot().services.studio).toMatchObject({
				desktop: "user",
				origin: "found",
				owner: "start",
				pid: 777,
			});

			await handlers.release({ signal: "SIGINT", type: "signal" });

			expect(status.snapshot().services.studio).toMatchObject({
				desktop: "user",
				origin: "found",
				owner: null,
				pid: 777,
				status: "open",
			});
			expect(native.processes.get(777)).toMatchObject({
				alive: true,
				...visible,
			});
			expect({
				bytes: memory.fileSystem.readFileSync(path.join(PROJECT, "game.rbxl"), "utf8"),
				saves: save.mock.calls,
			}).toStrictEqual({ bytes: "unsaved bytes stay off disk", saves: [] });
		},
	);

	it("shows and activates a hidden macOS app, then hides it without activation", async () => {
		expect.assertions(3);

		const { move, native } = fixture("darwin", true);
		const pin = native.addon.pinProcess;
		const pinned = pin(777);
		assert(pinned !== null);
		const visibility = vi.fn<(hidden: boolean) => boolean>(pinned.setAppHidden);
		native.addon.pinProcess = (pid) => {
			const current = pin(pid);
			assert(current !== null);
			return { ...current, setAppHidden: visibility };
		};

		await move({ desktop: "user" });

		expect(visibility).toHaveBeenCalledWith(false);
		expect(native.processes.get(777)).toMatchObject({
			activations: 1,
			appActive: true,
			appHidden: false,
			windowVisibility: "hidden",
		});

		await move({ desktop: "hidden" });

		expect(native.processes.get(777)).toMatchObject({
			activations: 1,
			appActive: false,
			appHidden: true,
			windowVisibility: "hidden",
		});
	});

	it("resets the idle timeout after a visibility request succeeds or fails", async () => {
		expect.assertions(4);

		const { idle, move, seams, status } = fixture("win32");
		seams.clock.now = () => 5000;

		await expect(move({ desktop: "hidden" })).resolves.toMatchObject({ to: "hidden" });
		expect(idle.idleAt()).toBe(65_000);

		seams.clock.now = () => 10_000;
		status.studio("closed", path.join(PROJECT, "game.rbxl"), null);

		await expect(move({ desktop: "user" })).rejects.toMatchObject({ code: "studio_not_open" });
		expect(idle.idleAt()).toBe(70_000);
	});

	it("cancels before checking whether a session Studio is open", async () => {
		expect.assertions(1);

		const { abort, move, status } = fixture("win32");
		status.studio("closed", path.join(PROJECT, "game.rbxl"), null);
		abort.abort();

		await expect(move({ desktop: "hidden" })).rejects.toMatchObject({ name: "AbortError" });
	});

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
				message: "No session Studio is open.",
			});
		},
	);

	it.for(["stopped", "stopping"] as const)("rejects a %s session", async (phase) => {
		expect.assertions(1);

		const { move, status } = fixture("win32");
		const snapshot = status.snapshot();
		vi.spyOn(status, "snapshot").mockReturnValue({ ...snapshot, phase });

		await expect(move({ desktop: "hidden" })).rejects.toMatchObject({
			code: "not_running",
			message: "The session is stopping.",
		});
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
			message: "No session Studio is open.",
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
			message: "No session Studio is open.",
		});

		vi.mocked(status.snapshot).mockReturnValue({
			...snapshot,
			services: { ...snapshot.services, studio: { ...snapshot.services.studio, pid: 888 } },
		});

		await expect(move({ desktop: "hidden" })).rejects.toMatchObject({
			code: "studio_not_open",
			message: "No session Studio is open.",
		});
	});

	it("rejects a session whose Studio has released the place", async () => {
		expect.assertions(1);

		const { memory, move } = fixture("win32");
		memory.fileSystem.rmSync(path.join(PROJECT, "game.rbxl.lock"));

		await expect(move({ desktop: "hidden" })).rejects.toMatchObject({
			code: "studio_not_open",
			message: "No session Studio is open.",
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
			message: {
				darwin: "The Studio app is no longer open.",
				win32: "The Studio windows are no longer open.",
			}[platform],
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
				message: {
					darwin: "Studio could not change its app visibility.",
					win32: "Studio could not change its window visibility.",
				}[platform],
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
			message: "Studio could not start its window hiding watcher.",
		});
	});
});
