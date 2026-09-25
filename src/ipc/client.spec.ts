import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryTransport, scriptedConnection } from "../../test/helpers/fake-ipc.ts";
import { ForgeError } from "../errors.ts";
import { callSessionAsync } from "./client.ts";
import { IPC_WAIT_MS } from "./protocol.ts";
import type { IpcServerOptions } from "./server.ts";
import { startIpcServer } from "./server.ts";
import type { IpcTransport } from "./transport.ts";

const ENDPOINT = "session";
const TARGET = { endpoint: ENDPOINT, token: "token" };

async function serveAsync(handlers: IpcServerOptions["handlers"]): Promise<IpcTransport> {
	const transport = createMemoryTransport();
	const server = startIpcServer(await transport.listenAsync(ENDPOINT), {
		handlers,
		token: TARGET.token,
	});
	onTestFinished(async () => {
		await server.closeAsync();
	});
	return transport;
}

describe(callSessionAsync, () => {
	it("should send the token and request and return the result", async () => {
		expect.assertions(2);

		const status = vi.fn<NonNullable<IpcServerOptions["handlers"]["status"]>>();
		status.mockResolvedValue({ running: true });
		const transport = await serveAsync({ status });

		await expect(
			callSessionAsync(transport, TARGET, "status", { params: { a: 1 } }),
		).resolves.toStrictEqual({ running: true });
		expect(status).toHaveBeenCalledExactlyOnceWith({ a: 1 });
	});

	it("should report no session when nothing listens", async () => {
		expect.assertions(1);

		await expect(
			callSessionAsync(createMemoryTransport(), TARGET, "status"),
		).rejects.toMatchObject({
			code: "not_running",
			hint: 'Start one with "forge up".',
			message: "No session answers at session.",
		});
	});

	it("should report a session that closes without an answer, as on a wrong token", async () => {
		expect.assertions(1);

		const transport = await serveAsync({ status: async () => ({}) });

		await expect(
			callSessionAsync(transport, { ...TARGET, token: "wrong" }, "status"),
		).rejects.toMatchObject({
			code: "supervisor_unresponsive",
			hint: "It may be stopping. Try again, or check its logs.",
			message: "The session at session gave no answer to status.",
		});
	});

	it("should throw the session's failure with its code", async () => {
		expect.assertions(1);

		const transport = await serveAsync({
			shutdown: async () => {
				throw new ForgeError("session_replaced", "replaced");
			},
		});

		await expect(callSessionAsync(transport, TARGET, "shutdown")).rejects.toMatchObject({
			code: "session_replaced",
		});
	});

	it("should wait for the answer as long as asked, and close the connection", async () => {
		expect.assertions(4);

		const connection = scriptedConnection([]);
		const transport: IpcTransport = {
			connectAsync: vi.fn<IpcTransport["connectAsync"]>().mockResolvedValue(connection),
			listenAsync: vi.fn<IpcTransport["listenAsync"]>(),
		};

		await expect(
			callSessionAsync(transport, TARGET, "sync", { responseTimeoutMs: 60_000 }),
		).rejects.toMatchObject({ code: "supervisor_unresponsive" });

		expect(connection.readTimeouts).toStrictEqual([60_000]);
		expect(connection.isClosed()).toBeTrue();
		expect(transport.connectAsync).toHaveBeenCalledWith(ENDPOINT, IPC_WAIT_MS);
	});
});
