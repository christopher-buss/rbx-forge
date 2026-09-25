import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import type { FakeProcess } from "../../test/helpers/native.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { STUDIO_OPEN_WAIT_MS } from "../client/studio.ts";
import { ForgeError } from "../errors.ts";
import { startIpcServer } from "../ipc/server.ts";
import type { Clock } from "../seams/clock.ts";
import type { ConfigLoader } from "../seams/config-loader.ts";
import type { Host } from "../seams/host.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { Environment } from "../seams/seams.ts";
import type { SessionStatus } from "../session/status.ts";
import {
	STUDIO_CLOSE_MS,
	STUDIO_CLOSE_POLL_MS,
	STUDIO_EXIT_TIMEOUT_MS,
	STUDIO_START_SLACK_MS,
} from "../studio/close-studio.ts";
import type { CommandContext } from "./context.ts";
import { runStopAsync } from "./stop.ts";

const PLACE = path.join(PROJECT, "game.rbxl");
const LOCK = "game.rbxl.lock";
const STUDIO = String.raw`C:\Roblox\Versions\version-1\RobloxStudioBeta.exe`;
const STUDIO_PID = 4242;
/** When the test lock files were last written. */
const LOCK_WRITTEN = Date.UTC(2026, 0, 1);
/** Boot time of the fake Linux host. */
const BOOT = Date.UTC(2025, 11, 31);

const KEPT = { deleted: [], mode: "keep", moved: [], warnings: [] };
const MOVED_NONE = { deleted: [], mode: "move", moved: [], warnings: [] };
const SESSION_FILES: Record<string, string> = {
	".forge/current": "s1\n",
	".forge/sessions/s1/supervisor.id": `${JSON.stringify({
		endpoint: "endpoint-s1",
		pid: 500,
		processStartTime: "500",
		sessionId: "s1",
		startedAt: "2026-01-01T00:00:00.000Z",
		version: "9.9.9",
	})}\n`,
	".forge/sessions/s1/token": "token",
};

interface StopProject {
	context: CommandContext;
	/** Milliseconds the clock moved. */
	elapsed: () => number;
	files: () => Record<string, null | string>;
	processes: Map<number, FakeProcess>;
}

/**
 * A sleep hook that runs `action` once the clock has moved `ms`.
 *
 * @param ms - When, in milliseconds after the start.
 * @param action - What happens then, once.
 * @returns The hook.
 */
function atElapsed(ms: number, action: () => void): (elapsed: number) => void {
	let isDone = false;
	return (elapsed) => {
		if (isDone || elapsed < ms) {
			return;
		}

		isDone = true;
		action();
	};
}

/**
 * A clock whose sleeps move time, and run `onSleep` after each move.
 *
 * @param onSleep - Runs with the time now.
 * @returns The clock and the time it moved.
 */
function steppingClock(onSleep: Array<(elapsed: number) => void>): {
	clock: Clock;
	elapsed: () => number;
} {
	let elapsed = 0;
	return {
		clock: {
			now: () => LOCK_WRITTEN + elapsed,
			sleep: async (ms) => {
				elapsed += ms;
				for (const hook of onSleep) {
					hook(elapsed);
				}
			},
		},
		elapsed: () => elapsed,
	};
}

function makeProject({
	config = {},
	env: environment = {},
	files = {},
	host = {},
	onSleep = [],
	processes = {},
}: {
	config?: Record<string, unknown>;
	env?: Environment;
	files?: Record<string, string>;
	host?: Partial<Host>;
	onSleep?: Array<(elapsed: number) => void>;
	processes?: Record<number, FakeProcess>;
} = {}): StopProject {
	const memory = createMemoryFileSystem(files);
	for (const file of Object.keys(files)) {
		memory.setModifiedTime(file, LOCK_WRITTEN);
	}

	for (const entry of Object.values(processes)) {
		entry.onClose ??= () => {
			memory.fileSystem.rmSync(`${PLACE}.lock`, { force: true });
		};
	}

	const native = createFakeNative(processes);
	const seams = createTestSeams();
	const { clock, elapsed } = steppingClock(onSleep);
	const configLoader = vi.fn<ConfigLoader>().mockResolvedValue({
		path: path.join(PROJECT, "rbx-forge.config.ts"),
		value: { projectType: "rbxts", ...config },
	});

	return {
		context: createCommandContext({
			env: environment,
			seams: {
				...seams,
				clock,
				configLoader,
				fileSystem: memory.fileSystem,
				host: { ...seams.host, bootTimeMs: () => BOOT, ...host },
				ipc: createMemoryTransport(),
				native: () => native.addon,
			},
		}),
		elapsed,
		files: memory.files,
		processes: native.processes,
	};
}

/**
 * Run session `s1` of the project: its files, and an endpoint whose
 * `status` reports this Studio.
 *
 * @param project - The stop test project.
 * @param studio - What the session reports about Studio, now.
 */
async function serveSessionAsync(
	project: StopProject,
	studio: () => SessionStatus["services"]["studio"],
): Promise<void> {
	const { fileSystem, ipc } = project.context.seams;
	for (const [file, content] of Object.entries(SESSION_FILES)) {
		const full = path.join(PROJECT, file);
		fileSystem.mkdirSync(path.dirname(full), { recursive: true });
		fileSystem.writeFileSync(full, content);
	}

	const server = startIpcServer(await ipc.listenAsync("endpoint-s1"), {
		handlers: {
			status: () => {
				return {
					phase: "ready",
					pid: 500,
					running: true,
					services: {
						compiler: { status: "off" },
						rojo: { port: 34_872, status: "ready" },
						studio: studio(),
						syncback: { status: "off" },
					},
					sessionId: "s1",
					startedAt: "2026-01-01T00:00:00.000Z",
				};
			},
		},
		token: "token",
	});
	onTestFinished(async () => {
		await server.closeAsync();
	});
}

function studioLock(pid: number, host = TEST_HOSTNAME): string {
	return `${pid}\nRobloxStudioBeta\n${host}\n4378769e-07d9-4eda-b5ee-187aa6c43cda\n\n`;
}

/**
 * A Linux start time: 10 ms ticks since {@link BOOT}.
 *
 * @param epochMs - When the process started.
 * @returns The start time as the addon reports it.
 */
function linuxStartTime(epochMs: number): string {
	return String((epochMs - BOOT) / 10);
}

/**
 * Let Studio close, and delete its lock file, just before forge's next call
 * of `member` on the file system.
 *
 * @param project - The stop test project.
 * @param project.context - Its run, whose file system is wrapped.
 * @param member - The file system call the close comes before.
 */
function closeStudioBefore({ context }: StopProject, member: "readFileSync" | "statSync"): void {
	const { fileSystem } = context.seams;
	const original: (...args: Array<never>) => unknown = fileSystem[member];
	let isClosed = false;
	context.seams.fileSystem = {
		...fileSystem,
		[member]: (...args: Array<never>) => {
			if (!isClosed) {
				isClosed = true;
				fileSystem.rmSync(`${PLACE}.lock`);
			}

			return original(...args);
		},
	};
}

/**
 * Make forge's calls of `member` on the file system fail with an OS error.
 *
 * @param project - The stop test project.
 * @param project.context - Its run, whose file system is wrapped.
 * @param member - The failing call.
 * @param code - The error's code, such as `EACCES`.
 */
function failOn({ context }: StopProject, member: "readFileSync" | "statSync", code: string): void {
	context.seams.fileSystem = {
		...context.seams.fileSystem,
		[member]: () => {
			throw Object.assign(new Error(`${code}: ${member}`), { code });
		},
	};
}

async function stopAsync({ context }: StopProject): Promise<CommandResult> {
	return runStopAsync(context, { config: {}, flags: {} });
}

async function catchStopErrorAsync(project: StopProject): Promise<ForgeError> {
	const error: unknown = await stopAsync(project).catch((err: unknown) => err);

	expect(error).toBeInstanceOf(ForgeError);

	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked on the line above
	return error as ForgeError;
}

describe(runStopAsync, () => {
	it("should close a verified Studio with a close request and remove its lock file", async () => {
		expect.assertions(3);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO } },
		});
		const result = await stopAsync(project);

		expect(result).toStrictEqual({
			data: {
				end: "exited",
				forced: false,
				pid: STUDIO_PID,
				place: PLACE,
				recovery: null,
				stopped: true,
			},
			summary: `Stopped Roblox Studio (PID ${STUDIO_PID}) for ${PLACE}.`,
		});
		expect(project.processes.get(STUDIO_PID)).toMatchObject({ alive: false, closeRequests: 1 });
		expect(project.files()).not.toHaveProperty(LOCK);
	});

	it("should give Studio a bounded time to close on the close request", async () => {
		expect.assertions(2);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: {
				[STUDIO_PID]: { alive: true, executablePath: STUDIO, onCloseRequest: "refuse" },
			},
		});
		await stopAsync(project);

		expect(project.elapsed()).toBe(STUDIO_CLOSE_MS);
		expect(STUDIO_CLOSE_MS).toBe(15_000);
	});

	it("should end Studio at once when a dialog blocks it", async () => {
		expect.assertions(3);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: {
				[STUDIO_PID]: { alive: true, executablePath: STUDIO, onCloseRequest: "dialog" },
			},
		});

		await expect(stopAsync(project)).resolves.toStrictEqual({
			data: {
				end: "dialog",
				forced: true,
				pid: STUDIO_PID,
				place: PLACE,
				recovery: MOVED_NONE,
				stopped: true,
			},
			summary: `Stopped Roblox Studio (PID ${STUDIO_PID}) for ${PLACE}: a dialog blocked it, so forge ended it without saving.`,
		});
		expect(project.elapsed()).toBe(0);
		expect(project.files()).not.toHaveProperty(LOCK);
	});

	it("should end Studio at once once it closed the place, without waiting for its exit", async () => {
		expect.assertions(2);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: {
				[STUDIO_PID]: { alive: true, executablePath: STUDIO, onCloseRequest: "linger" },
			},
		});

		await expect(stopAsync(project)).resolves.toMatchObject({
			data: { end: "lock_released", forced: false, recovery: null },
			summary: `Stopped Roblox Studio (PID ${STUDIO_PID}) for ${PLACE}.`,
		});
		expect(project.processes.get(STUDIO_PID)!.alive).toBeFalse();
	});

	it("should wait for the lock file or a dialog, looking every 50 ms", async () => {
		expect.assertions(3);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			onSleep: [
				atElapsed(4 * STUDIO_CLOSE_POLL_MS, () => {
					project.processes.get(STUDIO_PID)!.blocked = true;
				}),
			],
			processes: {
				[STUDIO_PID]: { alive: true, executablePath: STUDIO, onCloseRequest: "refuse" },
			},
		});

		await expect(stopAsync(project)).resolves.toMatchObject({ data: { end: "dialog" } });
		expect(project.elapsed()).toBe(4 * STUDIO_CLOSE_POLL_MS);
		expect(STUDIO_CLOSE_POLL_MS).toBe(50);
	});

	it("should count a failed dialog query as no dialog", async () => {
		expect.assertions(1);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: {
				[STUDIO_PID]: {
					alive: true,
					blocked: "throw",
					executablePath: STUDIO,
					onCloseRequest: "refuse",
				},
			},
		});

		await expect(stopAsync(project)).resolves.toMatchObject({ data: { end: "timeout" } });
	});

	it("should handle the auto-recovery files as --recovery says", async () => {
		expect.assertions(1);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: {
				[STUDIO_PID]: { alive: true, executablePath: STUDIO, onCloseRequest: "dialog" },
			},
		});

		await expect(
			runStopAsync(project.context, {
				config: { studio: { autoRecovery: "keep" } },
				flags: {},
			}),
		).resolves.toMatchObject({ data: { recovery: KEPT } });
	});

	it("should move the ended Studio's auto-recovery file out of the AutoSaves folder", async () => {
		expect.assertions(2);

		const saves = path.join(PROJECT, "home", "Documents", "ROBLOX", "AutoSaves");
		const file = path.join(saves, "game_AutoRecovery_0.rbxl");
		const project = makeProject({
			env: { HOME: path.join(PROJECT, "home") },
			files: { [LOCK]: studioLock(STUDIO_PID) },
			host: { platform: "darwin" },
			processes: {
				[STUDIO_PID]: {
					alive: true,
					executablePath: STUDIO,
					onCloseRequest: "dialog",
					startTime: String(LOCK_WRITTEN * 1000),
				},
			},
		});
		const { fileSystem } = project.context.seams;
		fileSystem.mkdirSync(saves, { recursive: true });
		fileSystem.writeFileSync(file, "place");

		await expect(stopAsync(project)).resolves.toMatchObject({
			data: { recovery: { mode: "move", moved: [{ from: file }], warnings: [] } },
		});
		expect(fileSystem.existsSync(file)).toBeFalse();
	});

	it.for([
		["exit", "exited"],
		["linger", "lock_released"],
	] as const)(
		"should leave the auto-recovery files of a Studio that closed the place by itself (%s)",
		async ([onCloseRequest, end]) => {
			expect.assertions(2);

			const saves = path.join(PROJECT, "home", "Documents", "ROBLOX", "AutoSaves");
			const file = path.join(saves, "game_AutoRecovery_0.rbxl");
			const project = makeProject({
				env: { HOME: path.join(PROJECT, "home") },
				files: { [LOCK]: studioLock(STUDIO_PID) },
				host: { platform: "darwin" },
				processes: {
					[STUDIO_PID]: {
						alive: true,
						executablePath: STUDIO,
						onCloseRequest,
						startTime: String(LOCK_WRITTEN * 1000),
					},
				},
			});
			const { fileSystem } = project.context.seams;
			fileSystem.mkdirSync(saves, { recursive: true });
			fileSystem.writeFileSync(file, "place");

			await expect(stopAsync(project)).resolves.toMatchObject({
				data: { end, forced: false, recovery: null },
			});
			expect(fileSystem.existsSync(file)).toBeTrue();
		},
	);

	it("should close the session's Studio through its pin", async () => {
		expect.assertions(2);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO } },
		});
		await serveSessionAsync(project, () => {
			return {
				pid: STUDIO_PID,
				place: path.join(PROJECT, "session.rbxl"),
				startTime: String(STUDIO_PID),
				status: "open",
			};
		});

		await expect(stopAsync(project)).resolves.toMatchObject({
			data: { end: "exited", pid: STUDIO_PID, place: path.join(PROJECT, "session.rbxl") },
		});
		expect(project.processes.get(STUDIO_PID)!.alive).toBeFalse();
	});

	it("should wait while the session's Studio is opening", async () => {
		expect.assertions(2);

		let status: SessionStatus["services"]["studio"] = { status: "opening" };
		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			onSleep: [
				atElapsed(1000, () => {
					status = { place: PLACE, status: "open" };
				}),
			],
			processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO } },
		});
		await serveSessionAsync(project, () => status);

		await expect(stopAsync(project)).resolves.toMatchObject({ data: { stopped: true } });
		expect(project.elapsed()).toBe(1000);
	});

	it("should stop waiting for a session's Studio that stays opening", async () => {
		expect.assertions(2);

		const project = makeProject();
		await serveSessionAsync(project, () => ({ status: "opening" }));

		await expect(stopAsync(project)).resolves.toMatchObject({ data: { stopped: false } });
		expect(project.elapsed()).toBe(STUDIO_OPEN_WAIT_MS);
	});

	it("should fall back to the lock file when the session's Studio is gone or closed", async () => {
		expect.assertions(2);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO } },
		});
		await serveSessionAsync(project, () => {
			return { pid: 9, place: PLACE, startTime: "9", status: "open" };
		});

		await expect(stopAsync(project)).resolves.toMatchObject({
			data: { pid: STUDIO_PID, stopped: true },
		});

		const closed = makeProject();
		await serveSessionAsync(closed, () => ({ place: PLACE, status: "closed" }));

		await expect(stopAsync(closed)).resolves.toMatchObject({ data: { stopped: false } });
	});

	it("should close a session's Studio that reused no PID, also with no lock file yet", async () => {
		expect.assertions(1);

		const project = makeProject({
			processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO, startTime: "1" } },
		});
		await serveSessionAsync(project, () => {
			return { pid: STUDIO_PID, place: PLACE, startTime: "2", status: "open" };
		});

		await expect(stopAsync(project)).resolves.toMatchObject({ data: { stopped: false } });
	});

	it("should report recovery it cannot do on an OS with no start times", async () => {
		expect.assertions(1);

		const project = makeProject({
			host: { platform: "freebsd" },
			processes: {
				[STUDIO_PID]: { alive: true, executablePath: STUDIO, onCloseRequest: "dialog" },
			},
		});
		await serveSessionAsync(project, () => {
			return {
				pid: STUDIO_PID,
				place: PLACE,
				startTime: String(STUDIO_PID),
				status: "open",
			};
		});

		await expect(stopAsync(project)).resolves.toMatchObject({
			data: {
				recovery: {
					deleted: [],
					mode: "move",
					moved: [],
					warnings: ["forge cannot read process start times on freebsd."],
				},
			},
		});
	});

	it("should kill nothing when the lock file names another Studio than the session's", async () => {
		expect.assertions(3);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: {
				7: { alive: true, executablePath: STUDIO },
				[STUDIO_PID]: { alive: true, executablePath: STUDIO },
			},
		});
		await serveSessionAsync(project, () => {
			return { pid: 7, place: PLACE, startTime: "7", status: "open" };
		});
		const error = await catchStopErrorAsync(project);

		expect(error.message).toBe(
			`${path.join(PROJECT, LOCK)} names PID ${STUDIO_PID}, not the Roblox Studio forge started (PID 7). Nothing was killed.`,
		);
		expect(error.hint).toBe("Close the other Roblox Studio that has the place open by hand.");
	});

	it("should close the session's Studio when the lock file names it too", async () => {
		expect.assertions(1);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO } },
		});
		await serveSessionAsync(project, () => {
			return { pid: STUDIO_PID, place: PLACE, startTime: String(STUDIO_PID), status: "open" };
		});

		await expect(stopAsync(project)).resolves.toMatchObject({
			data: { pid: STUDIO_PID, stopped: true },
		});
	});

	it("should end a Studio that stays open after the close request, without a save", async () => {
		expect.assertions(4);

		const waits: Array<number> = [];
		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: {
				[STUDIO_PID]: {
					alive: true,
					executablePath: STUDIO,
					onCloseRequest: "refuse",
					waits,
				},
			},
		});
		const result = await stopAsync(project);

		expect(result).toStrictEqual({
			data: {
				end: "timeout",
				forced: true,
				pid: STUDIO_PID,
				place: PLACE,
				recovery: MOVED_NONE,
				stopped: true,
			},
			summary: `Stopped Roblox Studio (PID ${STUDIO_PID}) for ${PLACE}: it did not close within ${STUDIO_CLOSE_MS / 1000} s, so forge ended it without saving.`,
		});
		expect(waits).toStrictEqual([STUDIO_EXIT_TIMEOUT_MS]);
		expect(project.processes.get(STUDIO_PID)).toMatchObject({ alive: false, closeRequests: 1 });
		expect(project.files()).not.toHaveProperty(LOCK);
	});

	it.for(["no_window", "throw"] as const)(
		"should end Studio at once when the close request does not go out (%s)",
		async (onCloseRequest) => {
			expect.assertions(3);

			const waits: Array<number> = [];
			const project = makeProject({
				files: { [LOCK]: studioLock(STUDIO_PID) },
				processes: {
					[STUDIO_PID]: { alive: true, executablePath: STUDIO, onCloseRequest, waits },
				},
			});
			const { data } = await stopAsync(project);

			expect(data).toMatchObject({ end: "no_window", forced: true, stopped: true });
			expect(waits).toStrictEqual([STUDIO_EXIT_TIMEOUT_MS]);
			expect(project.processes.get(STUDIO_PID)!.alive).toBeFalse();
		},
	);

	it("should not end a Studio that exits just before the close request", async () => {
		expect.assertions(2);

		const waits: Array<number> = [];
		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: {
				[STUDIO_PID]: {
					alive: true,
					executablePath: STUDIO,
					onCloseRequest: "exit_first",
					waits,
				},
			},
		});
		const { data } = await stopAsync(project);

		expect(data).toMatchObject({ end: "exited", forced: false, recovery: null, stopped: true });
		expect(waits).toStrictEqual([]);
	});

	it("should stop the Studio of the place forge open opens", async () => {
		expect.assertions(2);

		const project = makeProject({
			config: {
				buildOutputPath: "build.rbxl",
				open: { buildOutputPath: "places/open.rbxl" },
			},
			files: { "places/open.rbxl.lock": studioLock(STUDIO_PID) },
			processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO } },
		});
		const { data } = await stopAsync(project);

		expect(data).toMatchObject({ place: path.join(PROJECT, "places", "open.rbxl") });
		expect(project.processes.get(STUDIO_PID)!.alive).toBeFalse();
	});

	it("should report success without a kill when the place has no lock file", async () => {
		expect.assertions(1);

		await expect(stopAsync(makeProject())).resolves.toStrictEqual({
			data: { place: PLACE, stopped: false },
			summary: `Roblox Studio does not have ${PLACE} open.`,
		});
	});

	it("should kill nothing when the lock names a PID that a non-Studio process reused", async () => {
		expect.assertions(5);

		const node = String.raw`C:\Program Files\nodejs\node.exe`;
		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: { [STUDIO_PID]: { alive: true, executablePath: node } },
		});
		const error = await catchStopErrorAsync(project);

		expect(error.code).toBe("identity_mismatch");
		expect(error.message).toBe(
			`${path.join(PROJECT, LOCK)} names PID ${STUDIO_PID}, but that process is ${node}, not Roblox Studio. Nothing was killed.`,
		);
		expect(error.hint).toBe(
			"The lock file is stale. Delete it if Roblox Studio does not have the place open.",
		);
		expect(project.processes.get(STUDIO_PID)!.alive).toBeTrue();
	});

	it("should keep the lock file when it kills nothing", async () => {
		expect.assertions(2);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: { [STUDIO_PID]: { alive: true, executablePath: "/usr/bin/sleep" } },
		});
		await catchStopErrorAsync(project);

		expect(project.files()[LOCK]).toBe(studioLock(STUDIO_PID));
	});

	it("should report success without a kill when the PID has exited", async () => {
		expect.assertions(2);

		const project = makeProject({ files: { [LOCK]: studioLock(STUDIO_PID) } });

		await expect(stopAsync(project)).resolves.toStrictEqual({
			data: { pid: STUDIO_PID, place: PLACE, stopped: false },
			summary: `Roblox Studio is not running: the lock file names PID ${STUDIO_PID}, which has exited.`,
		});
		expect(project.files()[LOCK]).toBe(studioLock(STUDIO_PID));
	});

	it("should report success without a kill when the process exits while it is checked", async () => {
		expect.assertions(1);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: {
				[STUDIO_PID]: { alive: true, executablePath: STUDIO, exitsAfterPin: true },
			},
		});

		await expect(stopAsync(project)).resolves.toMatchObject({
			data: { pid: STUDIO_PID, stopped: false },
		});
	});

	it("should fail with identity_mismatch when the lock file names no PID", async () => {
		expect.assertions(3);

		const error = await catchStopErrorAsync(makeProject({ files: { [LOCK]: "garbage\n" } }));

		expect(error.code).toBe("identity_mismatch");
		expect(error.message).toBe(
			`${path.join(PROJECT, LOCK)} names no process. Nothing was killed.`,
		);
	});

	it("should fail with identity_mismatch when the OS will not let forge check the process", async () => {
		expect.assertions(4);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: {
				[STUDIO_PID]: {
					alive: true,
					executablePath: STUDIO,
					pinError: "Access is denied.",
				},
			},
		});
		const error = await catchStopErrorAsync(project);

		expect(error.code).toBe("identity_mismatch");
		expect(error.message).toBe(
			`Could not verify PID ${STUDIO_PID}: Access is denied. Nothing was killed.`,
		);
		expect(error.cause).toStrictEqual(new Error("Access is denied."));
	});

	it("should kill nothing when the lock file was written on another computer", async () => {
		expect.assertions(5);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID, "OTHER-PC") },
			processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO } },
		});
		const error = await catchStopErrorAsync(project);

		expect(error.code).toBe("identity_mismatch");
		expect(error.message).toBe(
			`${path.join(PROJECT, LOCK)} was written on OTHER-PC, not on this computer (${TEST_HOSTNAME}). Nothing was killed.`,
		);
		expect(error.hint).toBe("Stop Roblox Studio on the computer that has the place open.");
		expect(project.processes.get(STUDIO_PID)!.alive).toBeTrue();
	});

	it("should kill nothing when the lock file names no computer", async () => {
		expect.assertions(4);

		const project = makeProject({
			files: { [LOCK]: `${STUDIO_PID}\n` },
			processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO } },
		});
		const error = await catchStopErrorAsync(project);

		expect(error.code).toBe("identity_mismatch");
		expect(error.message).toBe(
			`${path.join(PROJECT, LOCK)} names no computer, so forge cannot tell that it is this one (${TEST_HOSTNAME}). Nothing was killed.`,
		);
		expect(project.processes.get(STUDIO_PID)!.alive).toBeTrue();
	});

	it("should kill a Studio that started up to the slack after the lock file was written", async () => {
		expect.assertions(1);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: {
				[STUDIO_PID]: {
					alive: true,
					executablePath: STUDIO,
					startTime: linuxStartTime(LOCK_WRITTEN + STUDIO_START_SLACK_MS),
				},
			},
		});
		await stopAsync(project);

		expect(project.processes.get(STUDIO_PID)!.alive).toBeFalse();
	});

	it("should kill nothing when the Studio started after the lock file was written", async () => {
		expect.assertions(5);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: {
				[STUDIO_PID]: {
					alive: true,
					executablePath: STUDIO,
					startTime: linuxStartTime(LOCK_WRITTEN + STUDIO_START_SLACK_MS + 10),
				},
			},
		});
		const error = await catchStopErrorAsync(project);

		expect(error.code).toBe("identity_mismatch");
		expect(error.message).toBe(
			`${path.join(PROJECT, LOCK)} names PID ${STUDIO_PID}, but that Roblox Studio started after the lock file was written, so it reused the PID. Nothing was killed.`,
		);
		expect(error.hint).toBe(
			"The lock file is stale. Delete it if Roblox Studio does not have the place open.",
		);
		expect(project.processes.get(STUDIO_PID)!.alive).toBeTrue();
	});

	it("should read the start time for the host OS", async () => {
		expect.assertions(3);

		// 2026-01-01T00:00:05Z as a Windows FILETIME: five seconds after the
		// lock file was written, so the PID was reused.
		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			host: { platform: "win32" },
			processes: {
				[STUDIO_PID]: {
					alive: true,
					executablePath: STUDIO,
					startTime: "134116992050000000",
				},
			},
		});
		const error = await catchStopErrorAsync(project);

		expect(error.message).toContain("started after the lock file was written");
		expect(project.processes.get(STUDIO_PID)!.alive).toBeTrue();
	});

	it("should kill nothing when forge cannot read start times on the OS", async () => {
		expect.assertions(4);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			host: { platform: "freebsd" },
			processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO } },
		});
		const error = await catchStopErrorAsync(project);

		expect(error.code).toBe("identity_mismatch");
		expect(error.message).toBe(
			`Could not verify PID ${STUDIO_PID}: forge cannot read process start times on freebsd. Nothing was killed.`,
		);
		expect(project.processes.get(STUDIO_PID)!.alive).toBeTrue();
	});

	it("should fail with native_missing when the addon does not load", async () => {
		expect.assertions(2);

		const project = makeProject({ files: { [LOCK]: studioLock(STUDIO_PID) } });
		project.context.seams.native = () => {
			throw new ForgeError("native_missing", "no addon");
		};

		const error = await catchStopErrorAsync(project);

		expect(error.code).toBe("native_missing");
	});

	it("should fail with process_failed when Studio does not exit in time", async () => {
		expect.assertions(4);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: {
				[STUDIO_PID]: {
					alive: true,
					executablePath: STUDIO,
					ignoresKill: true,
					onCloseRequest: "refuse",
				},
			},
		});
		const error = await catchStopErrorAsync(project);

		expect(error.code).toBe("process_failed");
		expect(error.message).toBe(
			`Roblox Studio (PID ${STUDIO_PID}) did not exit within ${STUDIO_EXIT_TIMEOUT_MS} ms.`,
		);
		expect(project.files()[LOCK]).toBe(studioLock(STUDIO_PID));
	});

	it("should report success without a kill when Studio deletes its lock file before forge reads it", async () => {
		expect.assertions(2);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO } },
		});
		closeStudioBefore(project, "readFileSync");

		await expect(stopAsync(project)).resolves.toStrictEqual({
			data: { place: PLACE, stopped: false },
			summary: `Roblox Studio does not have ${PLACE} open.`,
		});
		expect(project.processes.get(STUDIO_PID)!.alive).toBeTrue();
	});

	it("should kill nothing when Studio deletes its lock file while forge checks it", async () => {
		expect.assertions(2);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO } },
		});
		closeStudioBefore(project, "statSync");

		await expect(stopAsync(project)).resolves.toStrictEqual({
			data: { pid: STUDIO_PID, place: PLACE, stopped: false },
			summary: `Roblox Studio (PID ${STUDIO_PID}) closed ${PLACE} while forge checked it.`,
		});
		expect(project.processes.get(STUDIO_PID)!.alive).toBeTrue();
	});

	it("should report the stop when the closed Studio deleted its lock file itself", async () => {
		expect.assertions(2);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO } },
		});

		await expect(stopAsync(project)).resolves.toMatchObject({
			data: { pid: STUDIO_PID, place: PLACE, stopped: true },
		});
		expect(project.files()).not.toHaveProperty(LOCK);
	});

	it.for(["readFileSync", "statSync"] as const)(
		"should fail and kill nothing when %s fails for another reason than a missing file",
		async (member) => {
			expect.assertions(2);

			const project = makeProject({
				files: { [LOCK]: studioLock(STUDIO_PID) },
				processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO } },
			});
			failOn(project, member, "EACCES");

			await expect(stopAsync(project)).rejects.toThrow(`EACCES: ${member}`);
			expect(project.processes.get(STUDIO_PID)!.alive).toBeTrue();
		},
	);

	it("should fail when a thrown value is not an error", async () => {
		expect.assertions(1);

		const project = makeProject({ files: { [LOCK]: studioLock(STUDIO_PID) } });
		project.context.seams.fileSystem = {
			...project.context.seams.fileSystem,
			readFileSync: () => {
				// oxlint-disable-next-line typescript/only-throw-error -- a thrown value that is not an Error
				throw { code: "ENOENT" };
			},
		};

		await expect(stopAsync(project)).rejects.toStrictEqual({ code: "ENOENT" });
	});
});
