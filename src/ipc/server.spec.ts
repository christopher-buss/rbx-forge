import { assert, describe, expect, it, vi } from "vitest";

import type { ScriptedConnection } from "../../test/helpers/fake-ipc.ts";
import { queueListener, scriptedConnection } from "../../test/helpers/fake-ipc.ts";
import { ForgeError } from "../errors.ts";
import type { IpcListener, LineRead } from "./connection.ts";
import { IPC_WAIT_MS, OWNER_POLL_MS } from "./protocol.ts";
import type { IpcHandler, IpcOwner, IpcServerOptions } from "./server.ts";
import { serveConnectionAsync, startIpcServer } from "./server.ts";

const TOKEN = "secret-token";
const HELLO = `{"protocol":1,"token":"${TOKEN}","type":"hello"}`;
const STATUS = '{"method":"status","type":"request"}';
const OWN = '{"method":"own","params":{"parts":[]},"type":"request"}';
const RELEASE = '{"type":"release"}';

function makeOwner(joined: IpcHandler = async () => ({ added: [] })) {
	const join = vi.fn<IpcHandler>(joined);
	const leave = vi.fn<IpcOwner["leave"]>().mockResolvedValue({ stopped: [] });
	return { join, leave, owner: { join, leave } };
}

/**
 * Make each read of a scripted connection wait a turn of the event loop, as
 * a real read waits for its timeout: a held owner never starves timers.
 *
 * @param connection - The scripted connection.
 * @returns The same connection, with slow reads.
 */
function slowReads(connection: ScriptedConnection): ScriptedConnection {
	const { readLineAsync } = connection;
	/**
	 * Read after a turn of the event loop.
	 *
	 * @param timeoutMs - The read's bound.
	 * @returns What the scripted read got.
	 */
	async function slowReadAsync(timeoutMs: number): Promise<LineRead> {
		await new Promise((resolve) => {
			setImmediate(resolve);
		});
		return readLineAsync(timeoutMs);
	}

	connection.readLineAsync = slowReadAsync;
	return connection;
}

function lines(written: ReadonlyArray<string>): Array<unknown> {
	return written.map((line) => JSON.parse(line));
}

function options(handlers: IpcServerOptions["handlers"] = {}): IpcServerOptions {
	return { handlers, token: TOKEN };
}

function answered(written: ReadonlyArray<string>): unknown {
	expect(written).toHaveLength(1);

	return JSON.parse(written[0]!);
}

describe(serveConnectionAsync, () => {
	it("should answer a request that follows the right hello, then close", async () => {
		expect.assertions(4);

		const status = vi.fn<IpcHandler>().mockResolvedValue({ running: true });
		const connection = scriptedConnection([
			HELLO,
			'{"method":"status","params":{"a":1},"type":"request"}',
		]);
		await serveConnectionAsync(connection, options({ status }));

		expect(answered(connection.written)).toStrictEqual({
			ok: true,
			result: { running: true },
			type: "response",
		});
		expect(status).toHaveBeenCalledExactlyOnceWith({ a: 1 });
		expect(connection.isClosed()).toBeTrue();
	});

	it.for([
		["a wrong token", '{"protocol":1,"token":"secret_token","type":"hello"}'],
		["a token of another length", '{"protocol":1,"token":"secret","type":"hello"}'],
		["another protocol", `{"protocol":2,"token":"${TOKEN}","type":"hello"}`],
		["no hello", STATUS],
	] as const)("should close without an answer on %s", async ([, hello]) => {
		expect.assertions(3);

		const status = vi.fn<IpcHandler>();
		const connection = scriptedConnection([hello, STATUS]);
		await serveConnectionAsync(connection, options({ status }));

		expect(connection.written).toStrictEqual([]);
		expect(status).not.toHaveBeenCalled();
		expect(connection.isClosed()).toBeTrue();
	});

	it("should close without an answer when the hello or request never comes", async () => {
		expect.assertions(4);

		const silent = scriptedConnection([]);
		const helloOnly = scriptedConnection([HELLO, { type: "closed" }]);
		await serveConnectionAsync(silent, options());
		await serveConnectionAsync(helloOnly, { ...options(), waitMs: 5 });

		expect(silent.written).toStrictEqual([]);
		expect(silent.readTimeouts).toStrictEqual([IPC_WAIT_MS]);
		expect(helloOnly.written).toStrictEqual([]);
		expect(helloOnly.readTimeouts).toStrictEqual([5, 5]);
	});

	it("should answer a request it cannot read as a usage failure", async () => {
		expect.assertions(2);

		const connection = scriptedConnection([HELLO, "nonsense"]);
		await serveConnectionAsync(connection, options());

		expect(answered(connection.written)).toStrictEqual({
			error: { code: "usage", message: "The request is not one this session reads." },
			ok: false,
			type: "response",
		});
	});

	it("should answer a method it does not serve as unavailable", async () => {
		expect.assertions(2);

		const connection = scriptedConnection([HELLO, '{"method":"sync","type":"request"}']);
		await serveConnectionAsync(connection, options());

		expect(answered(connection.written)).toStrictEqual({
			error: { code: "command_unavailable", message: "This session does not serve sync." },
			ok: false,
			type: "response",
		});
	});

	it("should answer a handler's failure with its code, details, and hint", async () => {
		expect.assertions(4);

		const failing = scriptedConnection([HELLO, STATUS]);
		const crashing = scriptedConnection([HELLO, STATUS]);
		await serveConnectionAsync(
			failing,
			options({
				status: async () => {
					throw new ForgeError("hook_failed", "bad", { details: { a: 1 }, hint: "fix" });
				},
			}),
		);
		await serveConnectionAsync(
			crashing,
			options({
				status: async () => {
					throw new Error("boom");
				},
			}),
		);

		expect(answered(failing.written)).toStrictEqual({
			error: { code: "hook_failed", details: { a: 1 }, hint: "fix", message: "bad" },
			ok: false,
			type: "response",
		});
		expect(answered(crashing.written)).toStrictEqual({
			error: {
				code: "internal_error",
				hint: "This is a bug in forge. Please report it.",
				message: "boom",
			},
			ok: false,
			type: "response",
		});
	});

	it("should answer a failure without details or hint with neither", async () => {
		expect.assertions(2);

		const connection = scriptedConnection([HELLO, STATUS]);
		await serveConnectionAsync(
			connection,
			options({
				status: async () => {
					throw new ForgeError("not_running", "gone");
				},
			}),
		);

		expect(answered(connection.written)).toStrictEqual({
			error: { code: "not_running", message: "gone" },
			ok: false,
			type: "response",
		});
	});
});

describe("serveConnectionAsync with an owner", () => {
	it("should answer the join, then hold the connection until a release, and answer it", async () => {
		expect.assertions(4);

		const { join, leave, owner } = makeOwner();
		const connection = scriptedConnection([
			HELLO,
			OWN,
			{ type: "timed_out" },
			'{"type":"other"}',
			RELEASE,
		]);
		await serveConnectionAsync(connection, { ...options(), owner });

		expect(lines(connection.written)).toStrictEqual([
			{ ok: true, result: { added: [] }, type: "response" },
			{ ok: true, result: { stopped: [] }, type: "response" },
		]);
		expect(join).toHaveBeenCalledExactlyOnceWith({ parts: [] });
		expect(leave).toHaveBeenCalledExactlyOnceWith("release");
		expect(connection.readTimeouts.slice(2)).toStrictEqual([
			OWNER_POLL_MS,
			OWNER_POLL_MS,
			OWNER_POLL_MS,
		]);
	});

	it.for([
		["closes", { type: "closed" }],
		["sends a line that is too long", { type: "too_long" }],
	] as const)("should let go with no answer once the owner %s", async ([, end]) => {
		expect.assertions(3);

		const { leave, owner } = makeOwner();
		const connection = scriptedConnection([HELLO, OWN, end]);
		await serveConnectionAsync(connection, { ...options(), owner });

		expect(connection.written).toHaveLength(1);
		expect(leave).toHaveBeenCalledExactlyOnceWith("gone");
		expect(connection.isClosed()).toBeTrue();
	});

	it("should let go at once when the owner never got the join's answer", async () => {
		expect.assertions(2);

		const { leave, owner } = makeOwner();
		const connection = scriptedConnection([HELLO, OWN]);
		connection.writeAsync = async () => false;
		await serveConnectionAsync(connection, { ...options(), owner });

		expect(leave).toHaveBeenCalledExactlyOnceWith("gone");
		expect(connection.readTimeouts).toStrictEqual([IPC_WAIT_MS, IPC_WAIT_MS]);
	});

	it("should answer a failed join and hold nothing", async () => {
		expect.assertions(2);

		const { leave, owner } = makeOwner(async () => {
			throw new ForgeError("session_running", "owned");
		});
		const connection = scriptedConnection([HELLO, OWN, RELEASE]);
		await serveConnectionAsync(connection, { ...options(), owner });

		expect(lines(connection.written)).toStrictEqual([
			{ error: { code: "session_running", message: "owned" }, ok: false, type: "response" },
		]);
		expect(leave).not.toHaveBeenCalled();
	});

	it("should answer a failed release with its failure", async () => {
		expect.assertions(1);

		const { leave, owner } = makeOwner();
		leave.mockRejectedValue(new ForgeError("not_running", "stopping"));
		const connection = scriptedConnection([HELLO, OWN, RELEASE]);
		await serveConnectionAsync(connection, { ...options(), owner });

		expect(lines(connection.written)[1]).toStrictEqual({
			error: { code: "not_running", message: "stopping" },
			ok: false,
			type: "response",
		});
	});

	it("should answer own as unavailable with no owner", async () => {
		expect.assertions(2);

		const connection = scriptedConnection([HELLO, OWN]);
		await serveConnectionAsync(connection, options());

		expect(answered(connection.written)).toStrictEqual({
			error: { code: "command_unavailable", message: "This session does not serve own." },
			ok: false,
			type: "response",
		});
	});
});

describe(startIpcServer, () => {
	it("should end an owner's hold without a let go once it closes", async () => {
		expect.assertions(3);

		const listener = queueListener();
		const { join, leave, owner } = makeOwner();
		const server = startIpcServer(listener, { ...options(), owner });
		const connection = slowReads(scriptedConnection([HELLO, OWN]));
		listener.push(connection);
		await vi.waitFor(() => {
			assert(connection.readTimeouts.length > 2, "the owner is held");
		});
		await server.closeAsync();

		expect(join).toHaveBeenCalledOnce();
		expect(leave).not.toHaveBeenCalled();
		expect(connection.isClosed()).toBeTrue();
	});

	it("should serve each client on its own until closed", async () => {
		expect.assertions(3);

		const listener = queueListener();
		const { promise: held, resolve: release } =
			Promise.withResolvers<Record<string, unknown>>();
		const server = startIpcServer(
			listener,
			options({ shutdown: async () => held, status: async () => ({ n: 1 }) }),
		);
		const slow = scriptedConnection([HELLO, '{"method":"shutdown","type":"request"}']);
		const fast = scriptedConnection([HELLO, STATUS]);
		listener.push(slow, fast);
		await vi.waitFor(() => {
			assert(fast.isClosed(), "the fast client is served");
		});
		let isClosed = false;
		const closing = (async () => {
			await server.closeAsync();
			isClosed = true;
		})();
		await new Promise((resolve) => {
			setImmediate(resolve);
		});
		const wasClosedEarly = isClosed;
		release({ accepted: true });
		await closing;

		expect([wasClosedEarly, server.pending()]).toStrictEqual([false, 0]);
		expect(slow.written).toHaveLength(1);
		expect(listener.isClosed()).toBeTrue();
	});

	it("should stop serving when the listener fails", async () => {
		expect.assertions(1);

		const listener: IpcListener = {
			acceptAsync: vi.fn<IpcListener["acceptAsync"]>().mockRejectedValue(new Error("broken")),
			close: vi.fn<IpcListener["close"]>(),
		};

		await expect(startIpcServer(listener, options()).closeAsync()).resolves.toBeUndefined();
	});
});
