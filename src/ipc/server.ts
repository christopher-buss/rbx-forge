import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

import { toForgeError } from "../errors.ts";
import type { IpcConnection, IpcListener } from "./connection.ts";
import type { IpcFailure, IpcMethod, IpcRequest, IpcResponse } from "./protocol.ts";
import {
	encodeLine,
	IPC_PROTOCOL,
	IPC_WAIT_MS,
	isRelease,
	OWNER_POLL_MS,
	parseHello,
	parseRequest,
} from "./protocol.ts";

/**
 * Answers one method, now or later; throws or rejects with a `ForgeError`
 * to answer a failure.
 */
export type IpcHandler = (
	parameters: Readonly<Record<string, unknown>>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** How an owner let go: with a release line, or by leaving. */
export type OwnerLeave = "gone" | "release";

/** Serves `own`: a client that stays connected as the session's owner. */
export interface IpcOwner {
	/** Take the session for the client; its result is the first answer. */
	join: IpcHandler;
	/** The owner let go. Only a `release` gets the result as its answer. */
	leave: (how: OwnerLeave) => Promise<Record<string, unknown>>;
}

/** What a session serves. */
export interface IpcServerOptions {
	/**
	 * The methods it serves but `own`; a missing one is answered as
	 * unavailable.
	 */
	handlers: Partial<Record<Exclude<IpcMethod, "own">, IpcHandler>>;
	/** Called on each request it reads from a client with the token. */
	onRequest?: () => void;
	/** Serves `own`; without it, `own` is unavailable. */
	owner?: IpcOwner | undefined;
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

/** A close that never comes: a connection served on its own. */
const NEVER_CLOSES = new AbortController();
const NEVER_CLOSING = NEVER_CLOSES.signal;

/**
 * Serve one connection: check the hello, answer one request, close. A
 * missing, malformed, or wrong hello closes the connection without an
 * answer (wrong token closes). Every read and write is bounded. An `own`
 * request holds the connection until its owner lets go, or until
 * `closing` aborts.
 *
 * @param connection - The client.
 * @param options - The token and handlers.
 * @param closing - Aborts once the server closes: an owner's hold ends.
 */
export async function serveConnectionAsync(
	connection: IpcConnection,
	options: IpcServerOptions,
	closing: AbortSignal = NEVER_CLOSING,
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

		const request = parseRequest(second.line);
		if (request !== undefined) {
			options.onRequest?.();
		}

		if (request?.method === "own" && options.owner !== undefined) {
			await serveOwnerAsync(connection, options.owner, request.params, { closing, waitMs });
			return;
		}

		await connection.writeAsync(encodeLine(await answerAsync(options, request)), waitMs);
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
	const closing = new AbortController();

	async function acceptLoopAsync(): Promise<void> {
		for (;;) {
			const connection = await listener.acceptAsync();
			if (connection === undefined) {
				return;
			}

			const served = serveConnectionAsync(connection, options, closing.signal).finally(() => {
				serving.delete(served);
			});
			serving.add(served);
		}
	}

	// A listener that fails stops serving; the session runs on without it.
	const loop = acceptLoopAsync().catch(doNothing);
	return {
		closeAsync: async () => {
			closing.abort();
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
 * Run a handler and turn its outcome into a response.
 *
 * @param run - Calls the handler.
 * @returns A response for every outcome; never rejects.
 */
async function settleAsync(run: () => Promise<Record<string, unknown>>): Promise<IpcResponse> {
	try {
		return { ok: true, result: await run(), type: "response" };
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

/**
 * The answer to one request.
 *
 * @param options - The handlers.
 * @param request - The request, or `undefined` when its line is not one.
 * @returns A response for every outcome; never rejects.
 */
async function answerAsync(
	options: IpcServerOptions,
	request: IpcRequest | undefined,
): Promise<IpcResponse> {
	if (request === undefined) {
		return failure("usage", "The request is not one this session reads.");
	}

	const handler = request.method === "own" ? undefined : options.handlers[request.method];
	if (handler === undefined) {
		return failure("command_unavailable", `This session does not serve ${request.method}.`);
	}

	return settleAsync(async () => handler(request.params));
}

/**
 * Wait until an owner lets go: a release line, or the connection's end.
 * Other lines are ignored.
 *
 * @param connection - The owner.
 * @param closing - Aborts once the server closes.
 * @returns How it let go; `undefined` once the server closes first.
 */
async function waitForLeaveAsync(
	connection: IpcConnection,
	closing: AbortSignal,
): Promise<OwnerLeave | undefined> {
	while (!closing.aborted) {
		const read = await connection.readLineAsync(OWNER_POLL_MS);
		if (read.type === "line" && isRelease(read.line)) {
			return "release";
		}

		if (read.type === "closed" || read.type === "too_long") {
			return "gone";
		}
	}

	return undefined;
}

/**
 * Hold an owner's connection: answer the join, then wait until the owner
 * lets go, and answer a release. The owner's end without a release (it
 * died, or its terminal closed) lets go too. The server's close ends the
 * hold with no let go: the session is ending.
 *
 * @param connection - Where the owner reads and writes.
 * @param owner - Joins and lets go.
 * @param parameters - What the join asks for.
 * @param options - The server's close, and the bound of each write.
 * @param options.closing - Aborts once the server closes.
 * @param options.waitMs - How long each write waits.
 */
async function serveOwnerAsync(
	connection: IpcConnection,
	owner: IpcOwner,
	parameters: Readonly<Record<string, unknown>>,
	{ closing, waitMs }: { closing: AbortSignal; waitMs: number },
): Promise<void> {
	const joined = await settleAsync(async () => owner.join(parameters));
	const isHeard = await connection.writeAsync(encodeLine(joined), waitMs);
	if (!joined.ok) {
		return;
	}

	const how = isHeard ? await waitForLeaveAsync(connection, closing) : "gone";
	if (how === undefined) {
		return;
	}

	const left = await settleAsync(async () => owner.leave(how));
	if (how === "release") {
		await connection.writeAsync(encodeLine(left), waitMs);
	}
}

function doNothing(): void {
	// Nothing to do.
}
