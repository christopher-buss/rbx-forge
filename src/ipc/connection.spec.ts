import type { AddressInfo } from "node:net";
import { connect, createServer } from "node:net";
import { Duplex, duplexPair } from "node:stream";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { NativePipeConnection, NativePipeServer } from "../native/addon.ts";
import {
	nativeConnection,
	nativeListener,
	socketListener,
	streamConnection,
} from "./connection.ts";

/**
 * A stream whose writes never finish.
 *
 * @returns A duplex that reads nothing and never calls a write back.
 */
function stuckStream(): Duplex {
	return new Duplex({
		read: () => {
			// Nothing to read.
		},
		write: () => {
			// Never calls back.
		},
	});
}

function fakeNativeConnection(): NativePipeConnection {
	return {
		close: vi.fn<NativePipeConnection["close"]>(),
		readLine: vi.fn<NativePipeConnection["readLine"]>(),
		write: vi.fn<NativePipeConnection["write"]>(),
	};
}

describe(streamConnection, () => {
	it("should read lines split across chunks and keep the rest", async () => {
		expect.assertions(2);

		const [near, far] = duplexPair();
		const connection = streamConnection(near);
		far.write("one\ntw");
		far.write("o\nthree");

		await expect(connection.readLineAsync(1000)).resolves.toStrictEqual({
			line: "one",
			type: "line",
		});
		await expect(connection.readLineAsync(1000)).resolves.toStrictEqual({
			line: "two",
			type: "line",
		});
	});

	it("should wait for a line that comes later", async () => {
		expect.assertions(1);

		const [near, far] = duplexPair();
		const connection = streamConnection(near);
		const read = connection.readLineAsync(1000);
		setTimeout(() => {
			far.write("late\n");
		}, 10);

		await expect(read).resolves.toStrictEqual({ line: "late", type: "line" });
	});

	it("should time out when no line comes", async () => {
		expect.assertions(1);

		const [near, far] = duplexPair();
		far.write("partial");

		await expect(streamConnection(near).readLineAsync(20)).resolves.toStrictEqual({
			type: "timed_out",
		});
	});

	it("should report a close before a whole line", async () => {
		expect.assertions(1);

		const [near, far] = duplexPair();
		const connection = streamConnection(near);
		far.end("partial");

		await expect(connection.readLineAsync(1000)).resolves.toStrictEqual({ type: "closed" });
	});

	it("should stop reading past the line limit", async () => {
		expect.assertions(2);

		const [near, far] = duplexPair();
		const connection = streamConnection(near, 4);
		far.write("abcd");
		const exact = await connection.readLineAsync(20);
		far.write("e");

		expect(exact).toStrictEqual({ type: "timed_out" });
		await expect(connection.readLineAsync(1000)).resolves.toStrictEqual({ type: "too_long" });
	});

	it("should write to the other end, and end it on close", async () => {
		expect.assertions(3);

		const [near, far] = duplexPair();
		const connection = streamConnection(near);
		const other = streamConnection(far);

		await expect(connection.writeAsync("hi\n", 1000)).resolves.toBeTrue();
		await expect(other.readLineAsync(1000)).resolves.toStrictEqual({
			line: "hi",
			type: "line",
		});

		connection.close();

		await expect(other.readLineAsync(1000)).resolves.toStrictEqual({ type: "closed" });
	});

	it("should report a write that cannot finish in time or at all", async () => {
		expect.assertions(2);

		const [near] = duplexPair();
		const closed = streamConnection(near);
		near.destroy();

		await expect(streamConnection(stuckStream()).writeAsync("x", 20)).resolves.toBeFalse();
		await expect(closed.writeAsync("x", 1000)).resolves.toBeFalse();
	});

	it("should report a write that failed", async () => {
		expect.assertions(1);

		const failing = new Duplex({
			read: () => {
				// Nothing to read.
			},
			write: (_chunk, _encoding, callback) => {
				callback(new Error("broken"));
			},
		});

		await expect(streamConnection(failing).writeAsync("x", 1000)).resolves.toBeFalse();
	});
});

describe(nativeConnection, () => {
	it("should pass reads, writes, and close to the native connection", async () => {
		expect.assertions(5);

		const native = fakeNativeConnection();
		vi.mocked(native.readLine)
			.mockResolvedValueOnce({ kind: "line", line: "hello" })
			.mockResolvedValueOnce({ kind: "timed_out" });
		vi.mocked(native.write).mockResolvedValue(true);
		const connection = nativeConnection(native, 64);

		await expect(connection.readLineAsync(5)).resolves.toStrictEqual({
			line: "hello",
			type: "line",
		});
		await expect(connection.readLineAsync(5)).resolves.toStrictEqual({ type: "timed_out" });
		await expect(connection.writeAsync("x", 7)).resolves.toBeTrue();

		connection.close();

		expect(native.readLine).toHaveBeenCalledWith(64, 5);
		expect(native.close).toHaveBeenCalledOnce();
	});

	it("should read a line with no text as empty", async () => {
		expect.assertions(1);

		const native = fakeNativeConnection();
		vi.mocked(native.readLine).mockResolvedValue({ kind: "line" });

		await expect(nativeConnection(native).readLineAsync(5)).resolves.toStrictEqual({
			line: "",
			type: "line",
		});
	});
});

describe(nativeListener, () => {
	it("should wrap each client and end once the server is closed", async () => {
		expect.assertions(3);

		const client = fakeNativeConnection();
		vi.mocked(client.write).mockResolvedValue(true);
		const server: NativePipeServer = {
			accept: vi
				.fn<NativePipeServer["accept"]>()
				.mockResolvedValueOnce(client)
				.mockResolvedValueOnce(null),
			close: vi.fn<NativePipeServer["close"]>(),
			security: vi.fn<NativePipeServer["security"]>(),
		};
		const listener = nativeListener(server);
		const first = await listener.acceptAsync();
		await first!.writeAsync("x", 1);

		await expect(listener.acceptAsync()).resolves.toBeUndefined();

		listener.close();

		expect(client.write).toHaveBeenCalledWith("x", 1);
		expect(server.close).toHaveBeenCalledOnce();
	});
});

/**
 * A TCP server on a free port of `127.0.0.1`, closed when the test ends.
 *
 * @returns The listener over it and its port.
 */
async function listenAsync(): Promise<{
	listener: ReturnType<typeof socketListener>;
	port: number;
}> {
	const server = createServer();
	const listener = socketListener(server);
	await new Promise<void>((resolve) => {
		server.listen({ host: "127.0.0.1", port: 0 }, resolve);
	});
	onTestFinished(() => {
		listener.close();
	});
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a TCP server's address is an object
	return { listener, port: (server.address() as AddressInfo).port };
}

async function sendAsync(port: number, text: string): Promise<void> {
	const socket = connect({ host: "127.0.0.1", port });
	onTestFinished(() => {
		socket.destroy();
	});
	await new Promise<void>((resolve) => {
		socket.once("connect", resolve);
	});
	socket.write(text);
}

describe(socketListener, () => {
	it("should hand out clients that came before and after the accept", async () => {
		expect.assertions(2);

		const { listener, port } = await listenAsync();
		await sendAsync(port, "early\n");
		const early = await listener.acceptAsync();
		const late = listener.acceptAsync();
		await sendAsync(port, "late\n");

		await expect(early!.readLineAsync(1000)).resolves.toStrictEqual({
			line: "early",
			type: "line",
		});
		await expect((await late)!.readLineAsync(1000)).resolves.toStrictEqual({
			line: "late",
			type: "line",
		});
	});

	it("should end a pending accept and every later one on close", async () => {
		expect.assertions(2);

		const { listener } = await listenAsync();
		const pending = listener.acceptAsync();
		listener.close();

		await expect(pending).resolves.toBeUndefined();
		await expect(listener.acceptAsync()).resolves.toBeUndefined();
	});

	it("should drop clients nobody accepted on close", async () => {
		expect.assertions(1);

		const { listener, port } = await listenAsync();
		const socket = connect({ host: "127.0.0.1", port });
		const closed = new Promise<void>((resolve) => {
			socket.once("close", () => {
				resolve();
			});
		});
		socket.on("error", () => {
			// Reset by the close.
		});
		await new Promise<void>((resolve) => {
			socket.once("connect", resolve);
		});
		// Let the server see the connection first.
		await new Promise((resolve) => {
			setTimeout(resolve, 50);
		});
		listener.close();

		await expect(closed).resolves.toBeUndefined();
	});
});
