import { describe, expect, it } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { FlagValues } from "../cli/flags.ts";
import { DOWN_TIMEOUT_MS } from "../client/down.ts";
import type { Clock } from "../seams/clock.ts";
import { forgeFiles, sessionFiles } from "../supervisor/session-files.ts";
import type { CommandContext } from "./context.ts";
import { runDownAsync } from "./down.ts";

const FORGE = forgeFiles(PROJECT);
const FILES = sessionFiles(FORGE, "s1");
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
}: Setup = {}): { context: CommandContext; elapsed: () => number } {
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
	return { context, elapsed: () => now };
}

async function downAsync(context: CommandContext, flags: FlagValues = {}) {
	return runDownAsync(context, { config: {}, flags });
}

describe(runDownAsync, () => {
	it("should report stopped once the supervisor is gone and the barrier is clear", async () => {
		expect.assertions(1);

		const { context } = makeContext();

		await expect(downAsync(context)).resolves.toStrictEqual({
			data: { removed: true, sessionId: "s1", status: "stopped", stoppedBy: "gone" },
			summary: "Cleaned up after session s1; every process of it is gone.",
		});
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
