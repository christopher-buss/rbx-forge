import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import type { FakeNative, FakeProcess } from "../../test/helpers/native.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import type { FlagValues } from "../cli/flags.ts";
import { DOWN_TIMEOUT_MS } from "../client/down.ts";
import { startIpcServer } from "../ipc/server.ts";
import type { Clock } from "../seams/clock.ts";
import type { SessionStatus } from "../session/status.ts";
import { forgeFiles, sessionFiles } from "../supervisor/session-files.ts";
import type { CommandContext, CommandInput } from "./context.ts";
import { runDownAsync } from "./down.ts";

const FORGE = forgeFiles(PROJECT);
const FILES = sessionFiles(FORGE, "s1");
const PLACE = path.join(PROJECT, "game.rbxl");
const STUDIO_PID = 4242;
const STUDIO_OPEN: SessionStatus["services"]["studio"] = { place: PLACE, status: "open" };
const SESSION_FILES = {
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

interface Setup {
	/** A worker still holds the session's lease. */
	isLeaseHeld?: boolean;
	/** `.forge/current` names the session. */
	isNamed?: boolean;
	/** Its supervisor still runs, holding the singleton lock. */
	isSupervisorAlive?: boolean;
}

/**
 * A project with session `s1`, whose control endpoint never answers.
 *
 * @param setup - What is still alive.
 * @returns The context and the time the clock let pass.
 */
function makeContext({
	isLeaseHeld = false,
	isNamed = true,
	isSupervisorAlive = false,
}: Setup = {}): { context: CommandContext; elapsed: () => number; native: FakeNative } {
	const memory = createMemoryFileSystem(isNamed ? SESSION_FILES : {});
	const native = createFakeNative({ 500: { alive: isSupervisorAlive, executablePath: "/node" } });
	if (isSupervisorAlive) {
		native.addon.tryLockFile(FORGE.lock, "exclusive");
	}

	if (isLeaseHeld) {
		native.addon.tryLockFile(FILES.lease, "shared");
	}

	let now = 0;
	const clock: Clock = {
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
	};
	const context = createCommandContext({
		seams: createTestSeams({
			clock,
			fileSystem: memory.fileSystem,
			ipc: createMemoryTransport(),
			native: () => native.addon,
		}),
	});
	return { context, elapsed: () => now, native };
}

/**
 * Give session `s1` a Studio with its place open, and serve its endpoint:
 * `status` names the place, and `shutdown` ends the supervisor.
 *
 * @param project - The context and addon of {@link makeContext}.
 * @param project.context - The run.
 * @param project.native - Its addon.
 * @param studio - How the Studio process behaves.
 * @param entry - What the session reports about Studio.
 */
async function serveStudioAsync(
	{ context, native }: { context: CommandContext; native: FakeNative },
	studio: Partial<FakeProcess>,
	entry: SessionStatus["services"]["studio"] = STUDIO_OPEN,
): Promise<void> {
	const { fileSystem, ipc } = context.seams;
	fileSystem.writeFileSync(
		`${PLACE}.lock`,
		`${STUDIO_PID}\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
	);
	native.processes.set(STUDIO_PID, {
		alive: true,
		executablePath: String.raw`C:\Roblox\RobloxStudioBeta.exe`,
		onClose: () => {
			fileSystem.rmSync(`${PLACE}.lock`, { force: true });
		},
		...studio,
	});
	const status: SessionStatus = {
		phase: "ready",
		pid: 500,
		running: true,
		services: {
			compiler: { status: "off" },
			rojo: { port: 34_872, status: "ready" },
			studio: entry,
			syncback: { status: "off" },
		},
		sessionId: "s1",
		startedAt: "2026-01-01T00:00:00.000Z",
	};
	const server = startIpcServer(await ipc.listenAsync("endpoint-s1"), {
		handlers: {
			shutdown: () => {
				native.processes.get(500)!.alive = false;
				native.locks.delete(FORGE.lock);
				return { accepted: true };
			},
			status: () => ({ ...status }),
		},
		token: "token",
	});
	onTestFinished(async () => {
		await server.closeAsync();
	});
}

async function downAsync(
	context: CommandContext,
	flags: FlagValues = {},
	config: CommandInput["config"] = {},
) {
	return runDownAsync(context, { config, flags });
}

describe(runDownAsync, () => {
	it("should report stopped once the supervisor is gone and the barrier is clear", async () => {
		expect.assertions(1);

		const { context } = makeContext();

		await expect(downAsync(context)).resolves.toStrictEqual({
			data: {
				removed: true,
				sessionId: "s1",
				status: "stopped",
				stoppedBy: "gone",
				studio: { status: "unknown" },
			},
			summary: "Cleaned up after session s1; every process of it is gone.",
		});
	});

	it.for([
		["closes", {}, " Closed Roblox Studio (PID 4242)."],
		["closes and ends", { onCloseRequest: "linger" }, " Closed Roblox Studio (PID 4242)."],
		[
			"ends",
			{ onCloseRequest: "refuse" },
			" Roblox Studio (PID 4242): it did not close within 15 s, so forge ended it without saving.",
		],
		[
			"ends behind a dialog",
			{ onCloseRequest: "dialog" },
			" Roblox Studio (PID 4242): a dialog blocked it, so forge ended it without saving.",
		],
		[
			"ends with no window",
			{ onCloseRequest: "no_window" },
			" Roblox Studio (PID 4242): it had no window to close, so forge ended it without saving.",
		],
		[
			"cannot verify",
			{ executablePath: "/usr/bin/node" },
			` Roblox Studio may still have ${PLACE} open: ${PLACE}.lock names PID 4242, but that process is /usr/bin/node, not Roblox Studio. Nothing was killed.`,
		],
	] as const)(
		"should say in the summary when it %s the session's Studio",
		async ([, studio, sentence]) => {
			expect.assertions(1);

			const project = makeContext({ isSupervisorAlive: true });
			await serveStudioAsync(project, studio);

			await expect(downAsync(project.context)).resolves.toMatchObject({
				summary: `Stopped session s1; every process of it is gone.${sentence}`,
			});
		},
	);

	it("should handle the auto-recovery files as --recovery says", async () => {
		expect.assertions(1);

		const project = makeContext({ isSupervisorAlive: true });
		await serveStudioAsync(project, { onCloseRequest: "dialog" });

		await expect(
			downAsync(project.context, {}, { studio: { autoRecovery: "delete" } }),
		).resolves.toMatchObject({
			data: {
				studio: { recovery: { deleted: [], mode: "delete", moved: [], warnings: [] } },
			},
		});
	});

	it("should take the auto-recovery mode from the config file", async () => {
		expect.assertions(1);

		const project = makeContext({ isSupervisorAlive: true });
		project.context.seams.configLoader = async () => {
			return {
				path: path.join(PROJECT, "rbx-forge.config.json"),
				value: { projectType: "luau", studio: { autoRecovery: "keep" } },
			};
		};

		await serveStudioAsync(project, { onCloseRequest: "dialog" });

		await expect(downAsync(project.context)).resolves.toMatchObject({
			data: { studio: { recovery: { mode: "keep" } } },
		});
	});

	it("should say nothing of Studio when the session has none open", async () => {
		expect.assertions(1);

		const project = makeContext({ isSupervisorAlive: true });
		await serveStudioAsync(project, {}, { status: "off" });

		await expect(downAsync(project.context)).resolves.toMatchObject({
			data: { studio: { status: "none" } },
			summary: "Stopped session s1; every process of it is gone.",
		});
	});

	it("should leave the session's Studio open with --keep-studio", async () => {
		expect.assertions(2);

		const project = makeContext({ isSupervisorAlive: true });
		await serveStudioAsync(project, {});

		await expect(downAsync(project.context, { "keep-studio": true })).resolves.toMatchObject({
			data: { studio: { status: "kept" } },
			summary: "Stopped session s1; every process of it is gone. Roblox Studio stays open.",
		});
		expect(project.native.processes.get(STUDIO_PID)!.alive).toBeTrue();
	});

	it("should name a supervisor --force killed", async () => {
		expect.assertions(1);

		const { context } = makeContext({ isSupervisorAlive: true });

		await expect(downAsync(context, { force: true, timeout: "0" })).resolves.toMatchObject({
			data: { status: "stopped", stoppedBy: "killed" },
			summary: "Killed the supervisor of session s1; every process of it is gone.",
		});
	});

	it("should not kill the supervisor without --force", async () => {
		expect.assertions(1);

		const { context } = makeContext({ isSupervisorAlive: true });

		await expect(downAsync(context, { timeout: "0" })).rejects.toMatchObject({
			code: "supervisor_unresponsive",
		});
	});

	it("should wait the default bound for the barrier", async () => {
		expect.assertions(2);

		const { context, elapsed } = makeContext({ isLeaseHeld: true });

		await expect(downAsync(context)).rejects.toMatchObject({ code: "cleanup_in_progress" });
		expect(elapsed()).toBe(DOWN_TIMEOUT_MS);
	});

	it("should wait as long as --timeout says", async () => {
		expect.assertions(2);

		const { context, elapsed } = makeContext({ isLeaseHeld: true });

		await expect(downAsync(context, { timeout: "2.5" })).rejects.toMatchObject({
			code: "cleanup_in_progress",
		});
		expect(elapsed()).toBe(2500);
	});

	it.for(["-1", "soon", " "])("should refuse --timeout %j", async (timeout) => {
		expect.assertions(1);

		const { context } = makeContext();

		await expect(downAsync(context, { timeout })).rejects.toMatchObject({
			code: "usage",
			message: `--timeout takes a number of seconds, not "${timeout}".`,
		});
	});

	it("should report not_running when no session is named", async () => {
		expect.assertions(1);

		const { context } = makeContext({ isNamed: false });

		await expect(downAsync(context)).rejects.toMatchObject({
			code: "not_running",
			hint: 'Start one with "forge up".',
			message: "No session runs for this project.",
		});
	});
});
