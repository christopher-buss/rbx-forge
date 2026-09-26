import { ForgeError } from "../errors.ts";
import { failureError } from "../supervisor/channel.ts";
import type { IpcConnection } from "./connection.ts";
import type { IpcMethod } from "./protocol.ts";
import { encodeLine, IPC_PROTOCOL, IPC_WAIT_MS, OWNER_POLL_MS, parseResponse } from "./protocol.ts";
import type { IpcTransport } from "./transport.ts";

/** Where a session listens, and the token it wants. */
export interface IpcTarget {
	endpoint: string;
	token: string;
}

/** How one call waits. */
export interface IpcCallOptions {
	params?: Record<string, unknown>;
	/**
	 * How long the answer may take; the connect and writes wait {@link
	 * IPC_WAIT_MS}.
	 */
	responseTimeoutMs?: number;
}

/** A session this client holds as its owner, over one connection. */
export interface OwnedSession {
	/**
	 * Hold the session until `release` aborts, then let go.
	 *
	 * @returns The session's answer to the release; `undefined` when the
	 *   session closed the connection first: it ended.
	 * @rejects {ForgeError} `supervisor_unresponsive` when the release gets
	 *   no answer in time; the release's own failure.
	 */
	holdAsync: (
		release: AbortSignal,
		responseTimeoutMs: number,
	) => Promise<OwnerAnswer | undefined>;
	/** The session's answer to the join. */
	joined: OwnerAnswer;
}

/** A session's answer on an owner connection. */
type OwnerAnswer = Record<string, unknown>;

/**
 * Ask a running session one thing over its control channel.
 *
 * @param transport - Reaches the endpoint.
 * @param target - The endpoint and token.
 * @param method - What to ask.
 * @param options - Its params and how long the answer may take.
 * @returns The session's result.
 * @rejects {ForgeError} `not_running` when nothing listens at the endpoint;
 *   `supervisor_unresponsive` when it closes or stays silent; the session's
 *   own failure, with its code.
 */
export async function callSessionAsync(
	transport: IpcTransport,
	target: IpcTarget,
	method: IpcMethod,
	options: IpcCallOptions = {},
): Promise<Record<string, unknown>> {
	const connection = await transport.connectAsync(target.endpoint, IPC_WAIT_MS);
	if (connection === undefined) {
		throw notRunning(target);
	}

	try {
		await connection.writeAsync(requestLines(target, method, options.params), IPC_WAIT_MS);
		return await readAnswerAsync(connection, target, method, options.responseTimeoutMs);
	} finally {
		connection.close();
	}
}

/**
 * Join a running session as its owner (`own`), and keep the connection:
 * the session holds what it gave this client until the client lets go or
 * its connection ends, however this process ends.
 *
 * @param transport - Reaches the endpoint.
 * @param target - The endpoint and token.
 * @param options - The join's params, how long its answer may take, and a
 *   signal that gives up on the join.
 * @param options.signal - Aborts to give up: the connection closes, and the
 *   session lets go of what the join took.
 * @returns The held session; `undefined` when `signal` aborted first.
 * @rejects {ForgeError} As {@link callSessionAsync}.
 */
export async function ownSessionAsync(
	transport: IpcTransport,
	target: IpcTarget,
	options: IpcCallOptions & { signal: AbortSignal },
): Promise<OwnedSession | undefined> {
	const connection = await transport.connectAsync(target.endpoint, IPC_WAIT_MS);
	if (connection === undefined) {
		throw notRunning(target);
	}

	return joinOnAsync(connection, target, options);
}

/**
 * The hello and the request, as the lines a client writes first.
 *
 * @param target - The token.
 * @param method - What to ask.
 * @param parameters - Its params.
 * @returns Both lines.
 */
function requestLines(
	target: IpcTarget,
	method: IpcMethod,
	parameters: Record<string, unknown> = {},
): string {
	const hello = encodeLine({ protocol: IPC_PROTOCOL, token: target.token, type: "hello" });
	return hello + encodeLine({ method, params: parameters, type: "request" });
}

function notRunning(target: IpcTarget): ForgeError {
	return new ForgeError("not_running", `No session answers at ${target.endpoint}.`, {
		hint: 'Start one with "forge up".',
	});
}

/**
 * Read the session's answer to a request.
 *
 * @param connection - The connection the request went out on.
 * @param target - The endpoint, for the error.
 * @param method - What was asked, for the error.
 * @param timeoutMs - How long the answer may take.
 * @returns The session's result.
 * @rejects {ForgeError} `supervisor_unresponsive` with no answer; the
 *   session's own failure.
 */
async function readAnswerAsync(
	connection: IpcConnection,
	target: IpcTarget,
	method: string,
	timeoutMs: number = IPC_WAIT_MS,
): Promise<OwnerAnswer> {
	const read = await connection.readLineAsync(timeoutMs);
	const response = read.type === "line" ? parseResponse(read.line) : undefined;
	if (response === undefined) {
		throw new ForgeError(
			"supervisor_unresponsive",
			`The session at ${target.endpoint} gave no answer to ${method}.`,
			{ hint: "It may be stopping. Try again, or check its logs." },
		);
	}

	if (!response.ok) {
		throw failureError(response.error);
	}

	return response.result;
}

/**
 * Hold an owner connection until `release` aborts or the session closes it.
 *
 * @param connection - The owner connection.
 * @param target - The endpoint, for the error.
 * @param options - The release signal, and how long its answer may take.
 * @param options.release - Aborts to let go.
 * @param options.responseTimeoutMs - How long the release's answer may take.
 * @returns The release's answer; `undefined` once the session closed first.
 * @rejects As {@link readAnswerAsync}.
 */
async function holdAsync(
	connection: IpcConnection,
	target: IpcTarget,
	{ release, responseTimeoutMs }: { release: AbortSignal; responseTimeoutMs: number },
): Promise<OwnerAnswer | undefined> {
	try {
		while (!release.aborted) {
			const read = await connection.readLineAsync(OWNER_POLL_MS);
			if (read.type === "closed" || read.type === "too_long") {
				return undefined;
			}
		}

		await connection.writeAsync(encodeLine({ type: "release" }), IPC_WAIT_MS);
		return await readAnswerAsync(connection, target, "release", responseTimeoutMs);
	} finally {
		connection.close();
	}
}

/**
 * The join of {@link ownSessionAsync}, on a connection.
 *
 * @param connection - The connection to the session.
 * @param target - The token, and the endpoint for errors.
 * @param options - As {@link ownSessionAsync}.
 * @returns As {@link ownSessionAsync}.
 * @rejects As {@link ownSessionAsync}.
 */
async function joinOnAsync(
	connection: IpcConnection,
	target: IpcTarget,
	options: IpcCallOptions & { signal: AbortSignal },
): Promise<OwnedSession | undefined> {
	function close(): void {
		connection.close();
	}

	options.signal.addEventListener("abort", close, { once: true });
	try {
		await connection.writeAsync(requestLines(target, "own", options.params), IPC_WAIT_MS);
		const joined = await readAnswerAsync(connection, target, "own", options.responseTimeoutMs);
		if (options.signal.aborted) {
			close();
			return undefined;
		}

		return {
			holdAsync: async (release, responseTimeoutMs) => {
				return holdAsync(connection, target, { release, responseTimeoutMs });
			},
			joined,
		};
	} catch (err) {
		close();
		if (options.signal.aborted) {
			return undefined;
		}

		throw err;
	} finally {
		options.signal.removeEventListener("abort", close);
	}
}
