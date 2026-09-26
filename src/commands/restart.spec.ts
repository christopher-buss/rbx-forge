import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import type { FakeSession } from "../../test/helpers/fake-session.ts";
import { makeStatus, serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { Clock } from "../seams/clock.ts";
import type { ConfigLoader } from "../seams/config-loader.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { SessionStatus } from "../session/status.ts";
import type { CommandContext, CommandInput } from "./context.ts";
import { RESTART_FLAGS, runRestartAsync } from "./restart.ts";
import { UP_POLL_MS, UP_TIMEOUT_MS } from "./up.ts";

const INPUT: CommandInput = { config: {}, flags: {} };
const PLACE = path.join(PROJECT, "game.rbxl");

interface RestartRun {
	context: CommandContext;
	memory: ReturnType<typeof createMemoryFileSystem>;
	now: () => number;
	/** What runs on each sleep, with the time slept so far. */
	onSleep: Array<(now: number) => void>;
	transport: ReturnType<typeof createMemoryTransport>;
}

/**
 * A session with every part running and no owner.
 *
 * @param overrides - Fields to change.
 * @returns Its status.
 */
function everyPart(overrides: Partial<SessionStatus> = {}): SessionStatus {
	const status = makeStatus(overrides);
	return {
		...status,
		services: {
			...status.services,
			compiler: { building: false, owner: null, status: "ready" },
			studio: { owner: null, pid: 900, place: PLACE, startTime: "900", status: "open" },
		},
	};
}

function makeRestart(): RestartRun {
	const memory = createMemoryFileSystem();
	const transport = createMemoryTransport();
	const onSleep: Array<(now: number) => void> = [];
	let now = 0;
	const clock: Clock = {
		now: () => now,
		sleep: async (ms) => {
			now += ms;
			for (const hook of onSleep) {
				hook(now);
			}
		},
	};
	const configLoader = vi.fn<ConfigLoader>().mockResolvedValue({
		path: path.join(PROJECT, "rbx-forge.config.ts"),
		value: { projectType: "rbxts" },
	});
	const context = createCommandContext({
		seams: createTestSeams({
			clock,
			configLoader,
			fileSystem: memory.fileSystem,
			ipc: transport,
		}),
	});
	return { context, memory, now: () => now, onSleep, transport };
}

async function serveAsync(
	run: RestartRun,
	answer: Record<string, unknown>,
	status: SessionStatus = everyPart(),
): Promise<{ asked: Array<unknown>; fake: FakeSession }> {
	const fake = await serveFakeSessionAsync(run.memory, run.transport, status);
	const asked: Array<unknown> = [];

	fake.restartParts = (parameters) => {
		asked.push(parameters);
		return answer;
	};

	return { asked, fake };
}

async function restartAsync(run: RestartRun, input: CommandInput = INPUT): Promise<CommandResult> {
	return runRestartAsync(run.context, input);
}

/**
 * A sleep hook that makes the session ready once the time has come.
 *
 * @param fake - The session.
 * @param ms - When, in milliseconds after the start.
 * @returns The hook.
 */
function readyAt(fake: FakeSession, ms: number): (now: number) => void {
	return (now) => {
		if (now >= ms) {
			fake.status = everyPart();
		}
	};
}

const EVERY_PART = {
	added: ["compiler", "studio", "rojo"],
	kept: [],
	stopped: ["studio", "rojo", "compiler"],
	studio: {
		place: PLACE,
		stop: { end: "exited", forced: false, pid: 900, recovery: null, status: "stopped" },
	},
};

describe(runRestartAsync, () => {
	it("should fail with not_running when no session runs", async () => {
		expect.assertions(1);

		await expect(restartAsync(makeRestart())).rejects.toMatchObject({
			code: "not_running",
			hint: 'Start one with "forge up".',
			message: "No session runs for this project.",
		});
	});

	it("should restart every part it may touch and report the ready session", async () => {
		expect.assertions(2);

		const run = makeRestart();
		const { asked } = await serveAsync(run, EVERY_PART);
		const result = await restartAsync(run);

		expect(asked).toStrictEqual([{ force: false, recovery: "move", sessionId: "s1" }]);
		expect(result).toStrictEqual({
			data: {
				...everyPart(),
				added: ["compiler", "studio", "rojo"],
				kept: [],
				stopped: ["studio", "rojo", "compiler"],
			},
			summary: `Restarted the compiler, Studio, and Rojo of session s1: the compiler is ready, Rojo serves on port 34872, Studio has ${PLACE} open.`,
		});
	});

	it("should ask with --force, --recovery, and --studio-path", async () => {
		expect.assertions(1);

		const run = makeRestart();
		const { asked } = await serveAsync(run, EVERY_PART);
		await restartAsync(run, {
			config: { studio: { autoRecovery: "delete" } },
			flags: { "force": true, "studio-path": "tools/Studio" },
		});

		expect(asked).toStrictEqual([
			{
				force: true,
				recovery: "delete",
				sessionId: "s1",
				studioPath: path.join(PROJECT, "tools", "Studio"),
			},
		]);
	});

	it.for([
		[
			[{ owner: "start", part: "compiler" }],
			["studio", "rojo"],
			"Restarted Studio and Rojo of session s1",
			" It left the compiler alone: it has an owner, the forge start terminal.",
		],
		[
			[
				{ owner: "start", part: "studio" },
				{ owner: "start", part: "rojo" },
				{ owner: "start", part: "compiler" },
			],
			[],
			"Restarted no part of session s1",
			" It left Studio, Rojo, and the compiler alone: they have an owner, the forge start terminal.",
		],
	] as const)(
		"should name the owned parts it left alone: %j",
		async ([kept, added, start, end]) => {
			expect.assertions(1);

			const run = makeRestart();
			await serveAsync(run, { added, kept, stopped: added });
			const result = await restartAsync(run);

			expect(result).toMatchObject({
				data: { added, kept },
				summary: `${start}: the compiler is ready, Rojo serves on port 34872, Studio has ${PLACE} open.${end}`,
			});
		},
	);

	it("should fail as Studio's close failed", async () => {
		expect.assertions(1);

		const run = makeRestart();
		await serveAsync(run, {
			...EVERY_PART,
			studio: {
				error: { code: "identity_mismatch", hint: "Close it.", message: "Not Studio." },
				place: PLACE,
			},
		});

		await expect(restartAsync(run)).rejects.toMatchObject({
			code: "identity_mismatch",
			hint: "Close it.",
			message: "Not Studio.",
		});
	});

	it("should wait until no part is starting", async () => {
		expect.assertions(2);

		const run = makeRestart();
		const { fake } = await serveAsync(run, EVERY_PART, everyPart({ phase: "starting" }));
		run.onSleep.push(readyAt(fake, 3 * UP_POLL_MS));
		const result = await restartAsync(run);

		expect(result.data).toMatchObject({ phase: "ready" });
		expect(run.now()).toBe(3 * UP_POLL_MS);
	});

	it("should fail with supervisor_unresponsive when the session is not ready in time", async () => {
		expect.assertions(2);

		const run = makeRestart();
		await serveAsync(run, EVERY_PART, everyPart({ phase: "starting" }));

		await expect(restartAsync(run)).rejects.toMatchObject({
			code: "supervisor_unresponsive",
			hint: 'Check "forge status" and "forge logs compiler".',
			message: `The session was not ready within ${UP_TIMEOUT_MS / 1000} s.`,
		});
		expect(run.now()).toBe(UP_TIMEOUT_MS);
	});
});

describe("restart flags", () => {
	it("should take --force, --recovery, and --studio-path", () => {
		expect.assertions(1);

		expect(RESTART_FLAGS.map(({ name }) => name)).toStrictEqual([
			"force",
			"recovery",
			"studio-path",
		]);
	});
});
