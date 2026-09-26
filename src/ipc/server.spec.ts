import { assert, describe, expect, it, vi } from "vitest";

import { queueListener, scriptedConnection } from "../../test/helpers/fake-ipc.ts";
import { ForgeError } from "../errors.ts";
import type { IpcListener } from "./connection.ts";
import { IPC_WAIT_MS } from "./protocol.ts";
import type { IpcHandler, IpcServerOptions } from "./server.ts";
import { serveConnectionAsync, startIpcServer } from "./server.ts";

const TOKEN = "secret-token";
const HELLO = `{"protocol":1,"token":"${TOKEN}","type":"hello"}`;
const STATUS = '{"method":"status","type":"request"}';

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

	it("should count each request it reads as activity, before its answer", async () => {
		expect.assertions(2);

		const onRequest = vi.fn<() => void>();
		const status = vi.fn<IpcHandler>(() => {
			expect(onRequest).toHaveBeenCalledOnce();

			return {};
		});
		await serveConnectionAsync(scriptedConnection([HELLO, STATUS]), {
			...options({ status }),
			onRequest,
		});
		await serveConnectionAsync(scriptedConnection([HELLO, "nonsense"]), {
			...options({ status }),
			onRequest,
		});

		expect(onRequest).toHaveBeenCalledOnce();
	});

	it("should count no activity for a client with the wrong token", async () => {
		expect.assertions(1);

		const onRequest = vi.fn<() => void>();
		await serveConnectionAsync(
			scriptedConnection(['{"protocol":1,"token":"secret_token","type":"hello"}', STATUS]),
			{ ...options(), onRequest },
		);

		expect(onRequest).not.toHaveBeenCalled();
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

describe(startIpcServer, () => {
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
