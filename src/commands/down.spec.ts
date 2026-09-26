import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { makeStatus } from "../../test/helpers/fake-session.ts";
import type { FakeNative } from "../../test/helpers/native.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { FlagValues } from "../cli/flags.ts";
import { DOWN_TIMEOUT_MS } from "../client/down.ts";
import { startIpcServer } from "../ipc/server.ts";
import type { Clock } from "../seams/clock.ts";
import type { PartStops } from "../session/part-stops.ts";
import type { StudioEnd, StudioStop } from "../studio/close-studio.ts";
import { forgeFiles, sessionFiles } from "../supervisor/session-files.ts";
import type { CommandContext, CommandInput } from "./context.ts";
import { runDownAsync } from "./down.ts";

const FORGE = forgeFiles(PROJECT);
const FILES = sessionFiles(FORGE, "s1");
const PLACE = path.join(PROJECT, "game.rbxl");
const STUDIO_PID = 4242;
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
 * Serve session `s1`'s endpoint: `status` answers, `stopParts` answers
 * `stops` and records each request, and `shutdown` ends the supervisor.
 *
 * @param project - The context and addon of {@link makeContext}.
 * @param project.context - The run.
 * @param project.native - Its addon.
 * @param stops - What the session stopped.
 * @returns Every `stopParts` request's params.
 */
async function serveStopsAsync(
	{ context, native }: { context: CommandContext; native: FakeNative },
	stops: PartStops,
): Promise<Array<Record<string, unknown>>> {
	const requests: Array<Record<string, unknown>> = [];
	const server = startIpcServer(await context.seams.ipc.listenAsync("endpoint-s1"), {
		handlers: {
			shutdown: () => {
				native.processes.get(500)!.alive = false;
				native.locks.delete(FORGE.lock);
				return { accepted: true };
			},
			status: () => ({ ...makeStatus() }),
			stopParts: (parameters) => {
				requests.push(parameters);
				return { ...stops };
			},
		},
		token: "token",
	});
	onTestFinished(async () => {
		await server.closeAsync();
	});
	return requests;
}

/**
 * What a session answers once it closed its Studio.
 *
 * @param stop - How Studio went.
 * @returns The answer: Studio and Rojo stopped, the session ends.
 */
function closedStudio(stop: StudioStop): PartStops {
	return { ending: true, kept: [], stopped: ["studio", "rojo"], studio: { place: PLACE, stop } };
}

/**
 * A Studio forge ended, and how.
 *
 * @param end - How it ended.
 * @returns What closing it did.
 */
function ended(end: StudioEnd): StudioStop {
	return { end, forced: end !== "exited", pid: STUDIO_PID, recovery: null, status: "stopped" };
}

const NOTHING: PartStops = { ending: true, kept: [], stopped: [] };

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
				parts: null,
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
		["closes", ended("exited"), " Closed Roblox Studio (PID 4242)."],
		["closes and ends", ended("lock_released"), " Closed Roblox Studio (PID 4242)."],
		[
			"ends",
			ended("timeout"),
			" Roblox Studio (PID 4242): it did not close within 15 s, so forge ended it without saving.",
		],
		[
			"ends behind a dialog",
			ended("dialog"),
			" Roblox Studio (PID 4242): a dialog blocked it, so forge ended it without saving.",
		],
		[
			"ends with no window",
			ended("no_window"),
			" Roblox Studio (PID 4242): it had no window to close, so forge ended it without saving.",
		],
	] as const)(
		"should say in the summary when it %s the session's Studio",
		async ([, stop, sentence]) => {
			expect.assertions(1);

			const project = makeContext({ isSupervisorAlive: true });
			await serveStopsAsync(project, closedStudio(stop));

			await expect(downAsync(project.context)).resolves.toMatchObject({
				summary: `Stopped session s1; every process of it is gone.${sentence}`,
			});
		},
	);

	it("should say in the summary when the session cannot verify its Studio", async () => {
		expect.assertions(1);

		const project = makeContext({ isSupervisorAlive: true });
		await serveStopsAsync(project, {
			ending: true,
			kept: [],
			stopped: ["rojo"],
			studio: { error: { code: "identity_mismatch", message: "Not Studio." }, place: PLACE },
		});

		await expect(downAsync(project.context)).resolves.toMatchObject({
			summary: `Stopped session s1; every process of it is gone. Roblox Studio may still have ${PLACE} open: Not Studio.`,
		});
	});

	it("should ask the session to handle the auto-recovery files as --recovery says", async () => {
		expect.assertions(1);

		const project = makeContext({ isSupervisorAlive: true });
		const requests = await serveStopsAsync(project, NOTHING);
		await downAsync(project.context, {}, { studio: { autoRecovery: "delete" } });

		expect(requests).toStrictEqual([
			{ force: false, keepStudio: false, recovery: "delete", scope: "down", sessionId: "s1" },
		]);
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

		const requests = await serveStopsAsync(project, NOTHING);
		await downAsync(project.context);

		expect(requests).toMatchObject([{ recovery: "keep" }]);
	});

	it("should say when the session had no part to stop", async () => {
		expect.assertions(1);

		const project = makeContext({ isSupervisorAlive: true });
		await serveStopsAsync(project, NOTHING);

		await expect(downAsync(project.context)).resolves.toMatchObject({
			data: { parts: { kept: [], stopped: [] }, studio: { status: "none" } },
			summary: "Stopped session s1; every process of it is gone. It had no part to stop.",
		});
	});

	it("should leave the session's Studio open with --keep-studio", async () => {
		expect.assertions(2);

		const project = makeContext({ isSupervisorAlive: true });
		const requests = await serveStopsAsync(project, {
			ending: true,
			kept: [],
			stopped: ["rojo"],
		});

		await expect(downAsync(project.context, { "keep-studio": true })).resolves.toMatchObject({
			data: { studio: { status: "kept" } },
			summary: "Stopped session s1; every process of it is gone. Roblox Studio stays open.",
		});
		expect(requests).toMatchObject([{ keepStudio: true }]);
	});

	it.for([
		[
			["studio", "rojo", "compiler"],
			[],
			"Stopped Studio, Rojo, and the compiler of session s1. It goes on.",
		],
		[
			["rojo"],
			[
				{ owner: "start", part: "studio" },
				{ owner: "start", part: "compiler" },
			],
			"Stopped Rojo of session s1. It goes on: Studio and the compiler have an owner, the forge start terminal. Roblox Studio stays open.",
		],
		[
			[],
			[{ owner: "start", part: "compiler" }],
			"Stopped no part of session s1. It goes on: the compiler has an owner, the forge start terminal.",
		],
	] as const)(
		"should succeed and name the parts it kept: %j",
		async ([stopped, kept, summary]) => {
			expect.assertions(2);

			const project = makeContext({ isSupervisorAlive: true });
			await serveStopsAsync(project, {
				ending: false,
				kept: [...kept],
				stopped: [...stopped],
			});

			await expect(downAsync(project.context)).resolves.toMatchObject({
				data: { parts: { kept, stopped }, sessionId: "s1", status: "running" },
				summary,
			});
			expect(project.native.processes.get(500)!.alive).toBeTrue();
		},
	);

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
