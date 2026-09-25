import { ForgeError } from "../errors.ts";
import { failureError } from "../supervisor/channel.ts";
import type { IpcMethod } from "./protocol.ts";
import { encodeLine, IPC_PROTOCOL, IPC_WAIT_MS, parseResponse } from "./protocol.ts";
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
		throw new ForgeError("not_running", `No session answers at ${target.endpoint}.`, {
			hint: 'Start one with "forge up".',
		});
	}

	try {
		const hello = encodeLine({ protocol: IPC_PROTOCOL, token: target.token, type: "hello" });
		const request = encodeLine({ method, params: options.params ?? {}, type: "request" });
		await connection.writeAsync(hello + request, IPC_WAIT_MS);
		const read = await connection.readLineAsync(options.responseTimeoutMs ?? IPC_WAIT_MS);
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
	} finally {
		connection.close();
	}
}
