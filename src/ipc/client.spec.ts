import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryTransport, scriptedConnection } from "../../test/helpers/fake-ipc.ts";
import { ForgeError } from "../errors.ts";
import { callSessionAsync, ownSessionAsync } from "./client.ts";
import type { IpcConnection } from "./connection.ts";
import { IPC_WAIT_MS } from "./protocol.ts";
import type { IpcOwner, IpcServerOptions } from "./server.ts";
import { startIpcServer } from "./server.ts";
import type { IpcTransport } from "./transport.ts";

const ENDPOINT = "session";
const TARGET = { endpoint: ENDPOINT, token: "token" };

async function startAsync(handlers: IpcServerOptions["handlers"], owner?: IpcOwner) {
	const transport = createMemoryTransport();
	const server = startIpcServer(await transport.listenAsync(ENDPOINT), {
		handlers,
		owner,
		token: TARGET.token,
	});
	onTestFinished(async () => {
		await server.closeAsync();
	});
	return { server, transport };
}

async function serveAsync(
	handlers: IpcServerOptions["handlers"],
	owner?: IpcOwner,
): Promise<IpcTransport> {
	const { transport } = await startAsync(handlers, owner);
	return transport;
}

function makeOwner(join: IpcOwner["join"] = async () => ({ added: ["compiler"] })) {
	const leave = vi.fn<IpcOwner["leave"]>().mockResolvedValue({ stopped: ["compiler"] });
	return { join: vi.fn<IpcOwner["join"]>(join), leave };
}

const JOINED = '{"ok":true,"result":{},"type":"response"}';

function scriptedTransport(connection: IpcConnection): IpcTransport {
	return {
		connectAsync: vi.fn<IpcTransport["connectAsync"]>().mockResolvedValue(connection),
		listenAsync: vi.fn<IpcTransport["listenAsync"]>(),
	};
}

function never(): AbortSignal {
	const controller = new AbortController();
	return controller.signal;
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

describe(ownSessionAsync, () => {
	it("should join, hold the session, and let go with a release once asked", async () => {
		expect.assertions(4);

		const owner = makeOwner();
		const transport = await serveAsync({}, owner);
		const owned = await ownSessionAsync(transport, TARGET, {
			params: { parts: [] },
			signal: never(),
		});
		const release = new AbortController();
		const held = owned!.holdAsync(release.signal, 1000);
		await new Promise((resolve) => {
			setTimeout(resolve, 300);
		});
		const wasHeld = owner.leave.mock.calls.length;
		release.abort();

		expect(owned!.joined).toStrictEqual({ added: ["compiler"] });
		expect(owner.join).toHaveBeenCalledExactlyOnceWith({ parts: [] });
		await expect(held).resolves.toStrictEqual({ stopped: ["compiler"] });
		expect([wasHeld, owner.leave.mock.calls]).toStrictEqual([0, [["release"]]]);
	});

	it("should end the hold with no answer once the session closes the connection", async () => {
		expect.assertions(2);

		const owner = makeOwner();
		const { server, transport } = await startAsync({}, owner);
		const owned = await ownSessionAsync(transport, TARGET, { signal: never() });
		const held = owned!.holdAsync(never(), 1000);
		await server.closeAsync();

		await expect(held).resolves.toBeUndefined();
		expect(owner.leave).not.toHaveBeenCalled();
	});

	it("should give up on a join once its signal aborts, and the session lets go", async () => {
		expect.assertions(2);

		const joined = Promise.withResolvers<Record<string, unknown>>();
		const owner = makeOwner(async () => joined.promise);
		const transport = await serveAsync({}, owner);
		const stop = new AbortController();
		const owning = ownSessionAsync(transport, TARGET, { signal: stop.signal });
		await vi.waitFor(() => {
			assert(owner.join.mock.calls.length === 1, "the join is asked");
		});
		stop.abort();

		await expect(owning).resolves.toBeUndefined();

		joined.resolve({ added: [] });
		await vi.waitFor(() => {
			assert(owner.leave.mock.calls.length > 0, "the session lets go");
		}, IPC_WAIT_MS * 2);

		expect(owner.leave.mock.calls).toStrictEqual([["gone"]]);
	});

	it("should throw the join's failure, and report no session when nothing listens", async () => {
		expect.assertions(2);

		const transport = await serveAsync(
			{},
			makeOwner(async () => {
				throw new ForgeError("session_running", "owned");
			}),
		);

		await expect(ownSessionAsync(transport, TARGET, { signal: never() })).rejects.toMatchObject(
			{ code: "session_running" },
		);
		await expect(
			ownSessionAsync(createMemoryTransport(), TARGET, { signal: never() }),
		).rejects.toMatchObject({ code: "not_running" });
	});

	it("should report a release that gets no answer in time", async () => {
		expect.assertions(3);

		const connection = scriptedConnection(['{"ok":true,"result":{},"type":"response"}']);
		const transport: IpcTransport = {
			connectAsync: vi.fn<IpcTransport["connectAsync"]>().mockResolvedValue(connection),
			listenAsync: vi.fn<IpcTransport["listenAsync"]>(),
		};
		const owned = await ownSessionAsync(transport, TARGET, { signal: never() });
		const release = new AbortController();
		release.abort();

		await expect(owned!.holdAsync(release.signal, 5000)).rejects.toMatchObject({
			code: "supervisor_unresponsive",
			message: "The session at session gave no answer to release.",
		});
		expect(connection.written.at(-1)).toBe('{"type":"release"}\n');
		expect(connection.readTimeouts.at(-1)).toBe(5000);
	});

	it.for([
		["closes", { type: "closed" }],
		["sends a line that is too long", { type: "too_long" }],
	] as const)("should end the hold with no answer once the session %s", async ([, end]) => {
		expect.assertions(2);

		const connection = scriptedConnection([JOINED, end]);
		const owned = await ownSessionAsync(scriptedTransport(connection), TARGET, {
			signal: never(),
		});

		await expect(owned!.holdAsync(never(), 1000)).resolves.toBeUndefined();
		expect(connection.isClosed()).toBeTrue();
	});

	it("should close the connection when the join fails, or is given up once answered", async () => {
		expect.assertions(4);

		const failing = scriptedConnection([
			'{"error":{"code":"session_running","message":"m"},"ok":false,"type":"response"}',
		]);
		const silent = scriptedConnection([]);
		const given = scriptedConnection([JOINED]);
		const stop = new AbortController();
		stop.abort();

		await expect(
			ownSessionAsync(scriptedTransport(failing), TARGET, { signal: never() }),
		).rejects.toMatchObject({ code: "session_running" });
		await expect(
			ownSessionAsync(scriptedTransport(silent), TARGET, { signal: never() }),
		).rejects.toMatchObject({ message: "The session at session gave no answer to own." });
		await expect(
			ownSessionAsync(scriptedTransport(given), TARGET, { signal: stop.signal }),
		).resolves.toBeUndefined();
		expect([failing.isClosed(), silent.isClosed(), given.isClosed()]).toStrictEqual([
			true,
			true,
			true,
		]);
	});
});
