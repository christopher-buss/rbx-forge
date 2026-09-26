import { duplexPair } from "node:stream";

import type { IpcConnection, IpcListener, LineRead } from "../../src/ipc/connection.ts";
import { Handoff, streamConnection } from "../../src/ipc/connection.ts";
import type { IpcTransport } from "../../src/ipc/transport.ts";

/** A connection that reads a script and records what it is given. */
export interface ScriptedConnection extends IpcConnection {
	isClosed: () => boolean;
	/** The timeout of each read. */
	readTimeouts: Array<number>;
	/** Every write, in order. */
	written: Array<string>;
}

/** A listener fed by the test. */
export interface QueueListener extends IpcListener {
	isClosed: () => boolean;
	/** Hand the next accepts these clients, in order. */
	push: (...connections: Array<IpcConnection>) => void;
}

/** An in-memory transport: endpoints are names in a map. */
export interface MemoryTransport extends IpcTransport {
	/** The endpoints listening now. */
	endpoints: Map<string, QueueListener>;
}

/**
 * A connection whose reads return `script` in order, then `timed_out`.
 *
 * @param script - What each read gets; a string is a line.
 * @returns A connection that records its writes, read timeouts, and close.
 */
export function scriptedConnection(script: ReadonlyArray<LineRead | string>): ScriptedConnection {
	const reads = script.map((read): LineRead => {
		return typeof read === "string" ? { line: read, type: "line" } : read;
	});
	const written: Array<string> = [];
	const readTimeouts: Array<number> = [];
	let isClosed = false;
	return {
		close: () => {
			isClosed = true;
		},
		isClosed: () => isClosed,
		readLineAsync: async (timeoutMs) => {
			readTimeouts.push(timeoutMs);
			await nextTickAsync();
			return reads.shift() ?? { type: "timed_out" };
		},
		readTimeouts,
		writeAsync: async (text) => {
			written.push(text);
			await nextTickAsync();
			return true;
		},
		written,
	};
}

/**
 * A listener whose clients the test pushes.
 *
 * @returns A listener that hands out pushed clients in order.
 */
export function queueListener(): QueueListener {
	const clients = new Handoff<IpcConnection>();
	let isClosed = false;
	return {
		acceptAsync: async () => clients.takeAsync(),
		close: () => {
			isClosed = true;
			clients.close((client) => {
				client.close();
			});
		},
		isClosed: () => isClosed,
		push: (...connections) => {
			for (const connection of connections) {
				clients.push(connection);
			}
		},
	};
}

/**
 * A transport that connects clients to listeners of the same process over
 * in-memory stream pairs.
 *
 * @returns A transport whose endpoints are keys of `endpoints`.
 */
export function createMemoryTransport(): MemoryTransport {
	const endpoints = new Map<string, QueueListener>();
	return {
		connectAsync: async (endpoint) => {
			const listener = endpoints.get(endpoint);
			await nextTickAsync();
			if (listener === undefined || listener.isClosed()) {
				return;
			}

			const [client, server] = duplexPair();
			listener.push(streamConnection(server));
			return streamConnection(client);
		},
		endpoints,
		listenAsync: async (endpoint) => {
			const listener = queueListener();
			endpoints.set(endpoint, listener);
			await nextTickAsync();
			return listener;
		},
	};
}

/** Wait one microtask, as real I/O never answers in the same tick. */
async function nextTickAsync(): Promise<void> {
	await Promise.resolve();
}
