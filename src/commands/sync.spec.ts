import { describe, it, vi } from "vitest";

import { createMemoryTransport, scriptedConnection } from "../../test/helpers/fake-ipc.ts";
import { serveFakeSessionAsync, SYNCED } from "../../test/helpers/fake-session.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import type { IpcTransport } from "../ipc/transport.ts";
import { createJsonReporter } from "../output/reporters.ts";
import type { CommandContext } from "./context.ts";
import { runSyncAsync, SYNC_WAIT_MS } from "./sync.ts";

const HOOK = {
	id: "syncback:post:0",
	command: "lint",
	durationMs: 3,
	exitCode: 1,
	ok: false,
	outcome: "failed",
	outputTail: ["boom"],
};

function makeContext(ipc: IpcTransport = createMemoryTransport()): {
	context: CommandContext;
	memory: ReturnType<typeof createMemoryFileSystem>;
} {
	const memory = createMemoryFileSystem();
	return {
		context: createCommandContext({
			seams: createTestSeams({ fileSystem: memory.fileSystem, ipc }),
		}),
		memory,
	};
}

describe(runSyncAsync, () => {
	it("should preserve capture metadata from the session", async ({ expect }) => {
		expect.assertions(1);

		const ipc = createMemoryTransport();
		const { context, memory } = makeContext(ipc);
		const session = await serveFakeSessionAsync(memory, ipc);
		const capture = {
			bytes: 1024,
			desktop: "user",
			durationMs: 25,
			method: "capture",
			mtime: "2026-10-15T12:00:00.000Z",
			pid: 500,
			place: `${PROJECT}/game.rbxl`,
		};
		session.sync = () => ({ ...SYNCED, capture });

		await expect(runSyncAsync(context)).resolves.toMatchObject({ data: { capture } });
	});

	it("should retain capture warnings and emit their named NDJSON warning", async ({ expect }) => {
		expect.assertions(2);

		const ipc = createMemoryTransport();
		const { context, memory } = makeContext(ipc);
		const session = await serveFakeSessionAsync(memory, ipc);
		const warning = {
			property: "PhysicsSteppingMethod",
			reason: "unreadable",
			service: "Workspace",
		};
		const capture = {
			bytes: 1024,
			desktop: "user",
			durationMs: 25,
			method: "capture",
			mtime: "2026-10-15T12:00:00.000Z",
			pid: 500,
			place: `${PROJECT}/game.rbxl`,
			warnings: [warning],
		};
		session.sync = () => ({ ...SYNCED, capture });
		const events: Array<unknown> = [];

		const synced = await runSyncAsync({
			...context,
			reporter: createJsonReporter({
				stderr: () => {},
				stdout: (line) => {
					events.push(JSON.parse(line));
				},
			}),
		});

		expect(synced.data["capture"]).toStrictEqual(capture);
		expect(events).toStrictEqual([
			{
				...warning,
				message:
					"Workspace.PhysicsSteppingMethod cannot be captured; set it in the project file.",
				type: "warning",
			},
		]);
	});

	it("should reject malformed capture metadata from the session", async ({ expect }) => {
		expect.assertions(1);

		const ipc = createMemoryTransport();
		const { context, memory } = makeContext(ipc);
		const session = await serveFakeSessionAsync(memory, ipc);
		session.sync = () => ({ ...SYNCED, capture: { method: "capture" } });

		await expect(runSyncAsync(context)).rejects.toMatchObject({
			code: "internal_error",
			message: "The session answered sync with something else.",
		});
	});

	it("should return what the session synced, with its hooks", async ({ expect }) => {
		expect.assertions(1);

		const ipc = createMemoryTransport();
		const { context, memory } = makeContext(ipc);
		await serveFakeSessionAsync(memory, ipc);

		await expect(runSyncAsync(context)).resolves.toStrictEqual({
			data: SYNCED,
			summary: `Synced ${PROJECT}/game.rbxl into default.project.json through session s1.`,
		});
	});

	it("should fail with not_running when no session runs or its endpoint is silent", async ({
		expect,
	}) => {
		expect.assertions(2);

		const ipc = createMemoryTransport();
		const { context, memory } = makeContext(ipc);

		await expect(runSyncAsync(context)).rejects.toMatchObject({
			code: "not_running",
			hint: 'Start one with "forge up", or run "forge syncback" without a session.',
			message: "No session runs for this project.",
		});

		const session = await serveFakeSessionAsync(memory, ipc);
		await session.stop();

		await expect(runSyncAsync(context)).rejects.toMatchObject({ code: "not_running" });
	});

	it("should fail with the run's own error, its hook results kept", async ({ expect }) => {
		expect.assertions(1);

		const ipc = createMemoryTransport();
		const { context, memory } = makeContext(ipc);
		const session = await serveFakeSessionAsync(memory, ipc);
		session.sync = () => {
			throw new ForgeError("hook_failed", "lint failed.", { details: { hooks: [HOOK] } });
		};

		await expect(runSyncAsync(context)).rejects.toMatchObject({
			code: "hook_failed",
			details: { hooks: [HOOK] },
			message: "lint failed.",
		});
	});

	it("should fail with internal_error when the answer is not a sync result", async ({
		expect,
	}) => {
		expect.assertions(1);

		const ipc = createMemoryTransport();
		const { context, memory } = makeContext(ipc);
		const session = await serveFakeSessionAsync(memory, ipc);
		session.sync = () => ({ synced: true });

		await expect(runSyncAsync(context)).rejects.toMatchObject({
			code: "internal_error",
			hint: "The session may run another forge version. Stop it, then start it again.",
			message: "The session answered sync with something else.",
		});
	});

	it("should keep only the hook results it can read", async ({ expect }) => {
		expect.assertions(1);

		const ipc = createMemoryTransport();
		const { context, memory } = makeContext(ipc);
		const session = await serveFakeSessionAsync(memory, ipc);
		session.sync = () => ({ ...SYNCED, hooks: "not hooks" });

		await expect(runSyncAsync(context)).resolves.toMatchObject({ data: { hooks: [] } });
	});

	it("should wait long enough for a syncback and its hooks", async ({ expect }) => {
		expect.assertions(1);

		const memoryIpc = createMemoryTransport();
		const connection = scriptedConnection([
			JSON.stringify({ ok: true, result: SYNCED, type: "response" }),
		]);
		const ipc: IpcTransport = {
			connectAsync: vi.fn<IpcTransport["connectAsync"]>().mockResolvedValue(connection),
			listenAsync: memoryIpc.listenAsync,
		};
		const { context, memory } = makeContext(ipc);
		await serveFakeSessionAsync(memory, memoryIpc);
		await runSyncAsync(context);

		expect(connection.readTimeouts).toStrictEqual([SYNC_WAIT_MS]);
	});
});
