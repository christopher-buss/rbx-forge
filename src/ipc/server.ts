import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

import { toForgeError } from "../errors.ts";
import type { IpcConnection, IpcListener } from "./connection.ts";
import type { IpcFailure, IpcMethod, IpcResponse } from "./protocol.ts";
import { encodeLine, IPC_PROTOCOL, IPC_WAIT_MS, parseHello, parseRequest } from "./protocol.ts";

/**
 * Answers one method, now or later; throws or rejects with a `ForgeError`
 * to answer a failure.
 */
export type IpcHandler = (
	parameters: Readonly<Record<string, unknown>>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** What a session serves. */
export interface IpcServerOptions {
	/** The methods it serves; a missing one is answered as unavailable. */
	handlers: Partial<Record<IpcMethod, IpcHandler>>;
	/** The session's token; the hello must carry it. */
	token: string;
	/** How long each read and write waits. */
	waitMs?: number;
}

/** A running server. */
export interface IpcServer {
	/**
	 * Stop accepting, then wait until every request in progress has been
	 * answered.
	 */
	closeAsync: () => Promise<void>;
	/** How many requests are in progress. */
	pending: () => number;
}

/**
 * Serve one connection: check the hello, answer one request, close. A
 * missing, malformed, or wrong hello closes the connection without an
 * answer (spec #28: wrong token closes). Every read and write is bounded.
 *
 * @param connection - The client.
 * @param options - The token and handlers.
 */
export async function serveConnectionAsync(
	connection: IpcConnection,
	options: IpcServerOptions,
): Promise<void> {
	const waitMs = options.waitMs ?? IPC_WAIT_MS;
	try {
		const first = await connection.readLineAsync(waitMs);
		const hello = first.type === "line" ? parseHello(first.line) : undefined;
		if (
			hello === undefined ||
			hello.protocol !== IPC_PROTOCOL ||
			!isToken(hello.token, options.token)
		) {
			return;
		}

		const second = await connection.readLineAsync(waitMs);
		if (second.type !== "line") {
			return;
		}

		await connection.writeAsync(encodeLine(await answerAsync(options, second.line)), waitMs);
	} finally {
		connection.close();
	}
}

/**
 * Serve clients until closed. Each client is served on its own, so a slow
 * request never holds up the next.
 *
 * @param listener - The endpoint, listening.
 * @param options - The token and handlers.
 * @returns The running server.
 */
export function startIpcServer(listener: IpcListener, options: IpcServerOptions): IpcServer {
	const serving = new Set<Promise<void>>();

	async function acceptLoopAsync(): Promise<void> {
		for (;;) {
			const connection = await listener.acceptAsync();
			if (connection === undefined) {
				return;
			}

			const served = serveConnectionAsync(connection, options).finally(() => {
				serving.delete(served);
			});
			serving.add(served);
		}
	}

	// A listener that fails stops serving; the session runs on without it.
	const loop = acceptLoopAsync().catch(doNothing);
	return {
		closeAsync: async () => {
			listener.close();
			await loop;
			await Promise.all(serving);
		},
		pending: () => serving.size,
	};
}

function isToken(sent: string, token: string): boolean {
	const left = Buffer.from(sent);
	const right = Buffer.from(token);
	return left.length === right.length && timingSafeEqual(left, right);
}

function failure(code: string, message: string): IpcResponse {
	return { error: { code, message }, ok: false, type: "response" };
}

/**
 * The answer to one request.
 *
 * @param options - The handlers.
 * @param line - The request line.
 * @returns A response for every outcome; never rejects.
 */
async function answerAsync(options: IpcServerOptions, line: string): Promise<IpcResponse> {
	const request = parseRequest(line);
	if (request === undefined) {
		return failure("usage", "The request is not one this session reads.");
	}

	const handler = options.handlers[request.method];
	if (handler === undefined) {
		return failure("command_unavailable", `This session does not serve ${request.method}.`);
	}

	try {
		return { ok: true, result: await handler(request.params), type: "response" };
	} catch (err) {
		const { code, details, hint, message } = toForgeError(err);
		const error: IpcFailure = {
			code,
			message,
			...(details === undefined ? {} : { details: { ...details } }),
			...(hint === undefined ? {} : { hint }),
		};
		return { error, ok: false, type: "response" };
	}
}

function doNothing(): void {
	// Nothing to do.
}
