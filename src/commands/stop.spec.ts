import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { FakeProcess } from "../../test/helpers/native.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import type { ConfigLoader } from "../seams/config-loader.ts";
import type { Host } from "../seams/host.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { CommandContext } from "./context.ts";
import { runStopAsync, STUDIO_EXIT_TIMEOUT_MS, STUDIO_START_SLACK_MS } from "./stop.ts";

const PLACE = path.join(PROJECT, "game.rbxl");
const LOCK = "game.rbxl.lock";
const STUDIO = String.raw`C:\Roblox\Versions\version-1\RobloxStudioBeta.exe`;
const STUDIO_PID = 4242;
/** When the test lock files were last written. */
const LOCK_WRITTEN = Date.UTC(2026, 0, 1);
/** Boot time of the fake Linux host. */
const BOOT = Date.UTC(2025, 11, 31);

interface StopProject {
	context: CommandContext;
	files: () => Record<string, null | string>;
	processes: Map<number, FakeProcess>;
}

function makeProject({
	config = {},
	files = {},
	host = {},
	processes = {},
}: {
	config?: Record<string, unknown>;
	files?: Record<string, string>;
	host?: Partial<Host>;
	processes?: Record<number, FakeProcess>;
} = {}): StopProject {
	const memory = createMemoryFileSystem(files);
	for (const file of Object.keys(files)) {
		memory.setModifiedTime(file, LOCK_WRITTEN);
	}

	const native = createFakeNative(processes);
	const seams = createTestSeams();
	const configLoader = vi.fn<ConfigLoader>().mockResolvedValue({
		path: path.join(PROJECT, "rbx-forge.config.ts"),
		value: { projectType: "rbxts", ...config },
	});

	return {
		context: createCommandContext({
			seams: {
				...seams,
				configLoader,
				fileSystem: memory.fileSystem,
				host: { ...seams.host, bootTimeMs: () => BOOT, ...host },
				native: () => native.addon,
			},
		}),
		files: memory.files,
		processes: native.processes,
	};
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
	it("should kill a verified Studio and remove its lock file", async () => {
		expect.assertions(3);

		const project = makeProject({
			files: { [LOCK]: studioLock(STUDIO_PID) },
			processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO } },
		});
		const result = await stopAsync(project);

		expect(result).toStrictEqual({
			data: { pid: STUDIO_PID, place: PLACE, stopped: true },
			summary: `Stopped Roblox Studio (PID ${STUDIO_PID}) for ${PLACE}.`,
		});
		expect(project.processes.get(STUDIO_PID)!.alive).toBeFalse();
		expect(project.files()).not.toHaveProperty(LOCK);
	});

	it("should wait a bounded time for Studio to exit", async () => {
		expect.assertions(1);

		const waits: Array<number> = [];
		await stopAsync(
			makeProject({
				files: { [LOCK]: studioLock(STUDIO_PID) },
				processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO, waits } },
			}),
		);

		expect(waits).toStrictEqual([STUDIO_EXIT_TIMEOUT_MS]);
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
			processes: { [STUDIO_PID]: { alive: true, executablePath: STUDIO, ignoresKill: true } },
		});
		const error = await catchStopErrorAsync(project);

		expect(error.code).toBe("process_failed");
		expect(error.message).toBe(
			`Roblox Studio (PID ${STUDIO_PID}) did not exit within ${STUDIO_EXIT_TIMEOUT_MS} ms.`,
		);
		expect(project.files()[LOCK]).toBe(studioLock(STUDIO_PID));
	});
});
