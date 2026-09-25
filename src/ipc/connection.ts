import { Buffer } from "node:buffer";
import type { Server, Socket } from "node:net";
import type { Duplex } from "node:stream";

import type { NativePipeConnection, NativePipeServer } from "../native/addon.ts";
import { MAX_LINE_BYTES } from "./protocol.ts";

/** What one bounded line read got. */
export type LineRead =
	| { line: string; type: "line" }
	| { type: "closed" | "timed_out" | "too_long" };

/**
 * One connection of the control channel, either end: a Unix socket, a
 * named pipe client (both `node:net`), or a native pipe server connection.
 * Every call is bounded.
 */
export interface IpcConnection {
	/** Close it. Data already written still reaches the other end. */
	close: () => void;
	/** Read the next line, waiting at most `timeoutMs`. */
	readLineAsync: (timeoutMs: number) => Promise<LineRead>;
	/**
	 * Write `text`, waiting at most `timeoutMs`.
	 *
	 * @returns `false` when the other end left or the time passed first.
	 */
	writeAsync: (text: string, timeoutMs: number) => Promise<boolean>;
}

/** The server end of the control channel. */
export interface IpcListener {
	/** The next client; `undefined` once the listener is closed. */
	acceptAsync: () => Promise<IpcConnection | undefined>;
	/** Stop listening. A pending accept resolves `undefined`. */
	close: () => void;
}

/** The text a stream brought so far, and whether it ended. */
interface LineSource {
	hasEnded: boolean;
	text: string;
	/** Wakes the read waiting for more text. */
	wake: () => void;
}

/**
 * Items passed from producers to one consumer, in order. Items that come
 * while nobody takes wait in line.
 *
 * @template T - What is passed.
 */
export class Handoff<T> {
	private readonly waiting: Array<T> = [];

	private isClosed = false;
	private take: ((item: T | undefined) => void) | undefined;

	/**
	 * End it: waiting items go to `drop`, a pending take gets `undefined`.
	 *
	 * @param drop - Gets each item nobody took.
	 */
	public close(drop: (item: T) => void): void {
		this.isClosed = true;
		for (const item of this.waiting.splice(0)) {
			drop(item);
		}

		this.give(undefined);
	}

	/**
	 * Hand an item to the waiting take, or queue it.
	 *
	 * @param item - What to pass.
	 */
	public push(item: T): void {
		if (!this.give(item)) {
			this.waiting.push(item);
		}
	}

	/**
	 * The next item.
	 *
	 * @returns The oldest item, or `undefined` once closed.
	 */
	public async takeAsync(): Promise<T | undefined> {
		const next = this.waiting.shift();
		if (next !== undefined || this.isClosed) {
			return next;
		}

		return new Promise((resolve) => {
			this.take = resolve;
		});
	}

	private give(item: T | undefined): boolean {
		const resolve = this.take;
		this.take = undefined;
		resolve?.(item);
		return resolve !== undefined;
	}
}

/**
 * A connection over a stream: a `node:net` socket, or either half of a
 * `duplexPair` in tests.
 *
 * @param stream - The connected stream.
 * @param maxBytes - The longest line it reads.
 * @returns A connection that reads lines and writes text on `stream`.
 */
export function streamConnection(stream: Duplex, maxBytes: number = MAX_LINE_BYTES): IpcConnection {
	const source = watchLines(stream);
	return {
		close: () => {
			stream.end();
		},
		readLineAsync: async (timeoutMs) => {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const read = takeLine(source, maxBytes);
				if (read !== undefined) {
					return read;
				}

				if (!(await waitForTextAsync(source, deadline - Date.now()))) {
					return { type: "timed_out" };
				}
			}
		},
		writeAsync: async (text, timeoutMs) => writeWithinAsync(stream, text, timeoutMs),
	};
}

/**
 * A connection over a native pipe server connection (Windows).
 *
 * @param connection - A connection the native server accepted.
 * @param maxBytes - The longest line it reads.
 * @returns A connection that calls the native one.
 */
export function nativeConnection(
	connection: NativePipeConnection,
	maxBytes: number = MAX_LINE_BYTES,
): IpcConnection {
	return {
		close: () => {
			connection.close();
		},
		readLineAsync: async (timeoutMs) => {
			const { kind, line } = await connection.readLine(maxBytes, timeoutMs);
			return kind === "line" ? { line: line ?? "", type: "line" } : { type: kind };
		},
		writeAsync: async (text, timeoutMs) => connection.write(text, timeoutMs),
	};
}

/**
 * A listener over a native pipe server (Windows).
 *
 * @param server - The native server, already listening.
 * @returns A listener that accepts through the native server.
 */
export function nativeListener(server: NativePipeServer): IpcListener {
	return {
		acceptAsync: async () => {
			const connection = await server.accept();
			return connection === null ? undefined : nativeConnection(connection);
		},
		close: () => {
			server.close();
		},
	};
}

/**
 * A listener over a `node:net` server (a Unix socket). Clients that connect
 * before an accept wait in line; closing drops them.
 *
 * @param server - The server, listening or about to.
 * @returns A listener that hands out the server's sockets.
 */
export function socketListener(server: Server): IpcListener {
	const sockets = new Handoff<Socket>();
	server.on("connection", (socket) => {
		sockets.push(socket);
	});
	return {
		acceptAsync: async () => {
			const socket = await sockets.takeAsync();
			return socket === undefined ? undefined : streamConnection(socket);
		},
		close: () => {
			server.close();
			sockets.close((socket) => {
				socket.destroy();
			});
		},
	};
}

function doNothing(): void {
	// Nothing waits.
}

function watchLines(stream: Duplex): LineSource {
	const source: LineSource = { hasEnded: false, text: "", wake: doNothing };
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		source.text += chunk;
		source.wake();
	});
	function ended(): void {
		source.hasEnded = true;
		source.wake();
	}

	stream.once("end", ended);
	stream.once("close", ended);
	// The close that follows an error ends reads; this only keeps the error
	// from being thrown.
	stream.on("error", doNothing);
	return source;
}

/**
 * Take the next line out of the source, if the read can end now.
 *
 * @param source - The text so far.
 * @param maxBytes - The longest line.
 * @returns The read, or `undefined` to wait for more text.
 */
function takeLine(source: LineSource, maxBytes: number): LineRead | undefined {
	const newline = source.text.indexOf("\n");
	if (newline !== -1) {
		const line = source.text.slice(0, newline);
		source.text = source.text.slice(newline + 1);
		return { line, type: "line" };
	}

	if (Buffer.byteLength(source.text) > maxBytes) {
		return { type: "too_long" };
	}

	return source.hasEnded ? { type: "closed" } : undefined;
}

async function waitForTextAsync(source: LineSource, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			source.wake = doNothing;
			resolve(false);
		}, timeoutMs);
		source.wake = () => {
			clearTimeout(timer);
			source.wake = doNothing;
			resolve(true);
		};
	});
}

async function writeWithinAsync(stream: Duplex, text: string, timeoutMs: number): Promise<boolean> {
	if (!stream.writable) {
		return false;
	}

	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			resolve(false);
		}, timeoutMs);
		stream.write(text, (err) => {
			clearTimeout(timer);
			resolve(err === undefined || err === null);
		});
	});
}
