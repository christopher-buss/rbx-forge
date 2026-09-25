import { describe, expect, it } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { makeStatus, serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
} from "../../test/helpers/seams.ts";
import type { CommandContext } from "./context.ts";
import { runStatusAsync } from "./status.ts";

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
					lastBuild: { at: "t", diagnostics: [], errors: 2 },
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
						lastBuild: { at: "t", diagnostics: [], errors: 1 },
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
});
