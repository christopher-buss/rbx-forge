import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { makeStatus, serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
} from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import type { IpcHandler } from "../ipc/server.ts";
import type { CommandContext, CommandInput } from "./context.ts";
import { runStatusAsync } from "./status.ts";

function withFlags(flags: CommandInput["flags"]): CommandInput {
	return { config: {}, flags };
}

function makeContext(): {
	context: CommandContext;
	ipc: ReturnType<typeof createMemoryTransport>;
	memory: ReturnType<typeof createMemoryFileSystem>;
} {
	const memory = createMemoryFileSystem();
	const ipc = createMemoryTransport();
	return {
		context: createCommandContext({
			seams: createTestSeams({ fileSystem: memory.fileSystem, ipc }),
		}),
		ipc,
		memory,
	};
}

describe(runStatusAsync, () => {
	it("should return the running session's status", async () => {
		expect.assertions(1);

		const { context, ipc, memory } = makeContext();
		const status = makeStatus({
			services: {
				compiler: {
					building: false,
					lastBuild: { at: "t", diagnostics: [], errors: 2, startedAt: "t" },
					status: "ready",
				},
				rojo: { port: 4000, status: "ready" },
				studio: { status: "open" },
				syncback: {
					lastRun: { at: "t", durationMs: 1, hooks: [], ok: false },
					status: "idle",
				},
			},
		});
		await serveFakeSessionAsync(memory, ipc, status);

		await expect(runStatusAsync(context)).resolves.toStrictEqual({
			data: status,
			summary: [
				"Session s1 (pid 500): ready",
				"  rojo: ready on port 4000",
				"  compiler: ready, last build 2 errors",
				"  syncback: idle, last run failed",
				"  studio: open",
			].join("\n"),
		});
	});

	it("should describe a session with no build or syncback run yet", async () => {
		expect.assertions(1);

		const { context, ipc, memory } = makeContext();
		await serveFakeSessionAsync(
			memory,
			ipc,
			makeStatus({
				phase: "starting",
				services: {
					compiler: {
						building: false,
						lastBuild: { at: "t", diagnostics: [], errors: 1, startedAt: "t" },
						status: "ready",
					},
					rojo: { port: 1, status: "starting" },
					studio: { status: "off" },
					syncback: {
						lastRun: { at: "t", durationMs: 1, hooks: [], ok: true },
						status: "running",
					},
				},
			}),
		);

		await expect(runStatusAsync(context)).resolves.toMatchObject({
			summary: [
				"Session s1 (pid 500): starting",
				"  rojo: starting on port 1",
				"  compiler: ready, last build 1 error",
				"  syncback: running, last run ok",
				"  studio: off",
			].join("\n"),
		});
	});

	it("should report the plain lines of a fresh session", async () => {
		expect.assertions(1);

		const { context, ipc, memory } = makeContext();
		await serveFakeSessionAsync(memory, ipc);

		await expect(runStatusAsync(context)).resolves.toMatchObject({
			summary: [
				"Session s1 (pid 500): ready",
				"  rojo: ready on port 34872",
				"  compiler: off",
				"  syncback: off",
				"  studio: off",
			].join("\n"),
		});
	});

	it("should fail with not_running when no session runs or its endpoint is silent", async () => {
		expect.assertions(2);

		const { context, ipc, memory } = makeContext();
		const none = runStatusAsync(context);

		await expect(none).rejects.toMatchObject({
			code: "not_running",
			hint: 'Start one with "forge up".',
			message: "No session runs for this project.",
		});

		const session = await serveFakeSessionAsync(memory, ipc);
		await session.stop();

		await expect(runStatusAsync(context)).rejects.toMatchObject({ code: "not_running" });
	});

	it("should ask the session for a fresh build with --wait, for 300 s by default", async () => {
		expect.assertions(2);

		const { context, ipc, memory } = makeContext();
		const status = makeStatus();
		const session = await serveFakeSessionAsync(memory, ipc, status);
		const asked = vi.fn<IpcHandler>(() => ({ ...status }));
		session.freshStatus = asked;

		await expect(runStatusAsync(context, withFlags({ wait: true }))).resolves.toMatchObject({
			data: status,
		});
		expect(asked).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 300_000 });
	});

	it.for([
		["0", 0],
		["2", 2000],
		["0.5", 500],
		["2147000", 2_147_000_000],
	] as const)("should pass --timeout %s (seconds) on to the wait", async ([seconds, ms]) => {
		expect.assertions(1);

		const { context, ipc, memory } = makeContext();
		const session = await serveFakeSessionAsync(memory, ipc);
		const asked = vi.fn<IpcHandler>(() => ({ ...session.status }));
		session.freshStatus = asked;
		await runStatusAsync(context, withFlags({ timeout: seconds, wait: true }));

		expect(asked).toHaveBeenCalledExactlyOnceWith({ timeoutMs: ms });
	});

	it("should give the session time to answer past the wait itself", async () => {
		expect.assertions(1);

		const { context, ipc, memory } = makeContext();
		const session = await serveFakeSessionAsync(memory, ipc);
		session.freshStatus = async () => {
			await sleep(50);
			return { ...session.status };
		};

		await expect(
			runStatusAsync(context, withFlags({ timeout: "0", wait: true })),
		).resolves.toMatchObject({ data: session.status });
	});

	it("should ask for the status now without --wait", async () => {
		expect.assertions(1);

		const { context, ipc, memory } = makeContext();
		const session = await serveFakeSessionAsync(memory, ipc);
		session.freshStatus = () => {
			throw new ForgeError("compile_timeout", "Not asked.");
		};

		await expect(runStatusAsync(context)).resolves.toMatchObject({ data: session.status });
	});

	it("should fail with the session's compile_timeout", async () => {
		expect.assertions(1);

		const { context, ipc, memory } = makeContext();
		const session = await serveFakeSessionAsync(memory, ipc);
		session.freshStatus = () => {
			throw new ForgeError("compile_timeout", "No fresh build within 2000 ms.");
		};

		await expect(runStatusAsync(context, withFlags({ wait: true }))).rejects.toMatchObject({
			code: "compile_timeout",
		});
	});

	it.for([
		[{ timeout: "2" }, "--timeout needs --wait."],
		[{ timeout: "soon", wait: true }, '--timeout takes a number of seconds, not "soon".'],
		[{ timeout: "-1", wait: true }, '--timeout takes a number of seconds, not "-1".'],
		[{ timeout: " ", wait: true }, '--timeout takes a number of seconds, not " ".'],
		[{ timeout: true, wait: true }, '--timeout takes a number of seconds, not "true".'],
		[{ timeout: "2147001", wait: true }, '--timeout takes a number of seconds, not "2147001".'],
	] as const)("should fail with usage for the flags %j", async ([flags, message]) => {
		expect.assertions(1);

		const { context } = makeContext();

		await expect(runStatusAsync(context, withFlags(flags))).rejects.toMatchObject({
			code: "usage",
			message,
		});
	});

	it("should show a compile that runs", async () => {
		expect.assertions(1);

		const { context, ipc, memory } = makeContext();
		await serveFakeSessionAsync(
			memory,
			ipc,
			makeStatus({
				services: {
					...makeStatus().services,
					compiler: { building: true, status: "starting" },
				},
			}),
		);

		const { summary } = await runStatusAsync(context);

		expect(summary).toContain("  compiler: starting, building\n");
	});
});
