import { type } from "arktype";

/**
 * The control channel of a running session: one request per
 * connection, as JSON lines. The client writes a {@link IpcHello} with the
 * session's token, then one {@link IpcRequest}; the supervisor answers with
 * one {@link IpcResponse} and closes. A wrong token or protocol closes the
 * connection without an answer. There is no streaming.
 */

/** The protocol version both ends speak. */
export const IPC_PROTOCOL = 1;

/** How long each read and write of the channel waits. */
export const IPC_WAIT_MS = 2000;

/** The longest line either end reads. */
export const MAX_LINE_BYTES = 1_048_576;

/** What a client can ask a session. */
export type IpcMethod = "shutdown" | "status" | "sync";

/** The first line: who is asking. */
export interface IpcHello {
	protocol: number;
	token: string;
	type: "hello";
}

/** The second line: what is asked. */
export interface IpcRequest {
	method: IpcMethod;
	params: Record<string, unknown>;
	type: "request";
}

/** A failed request, as the supervisor reports it. */
export interface IpcFailure {
	code: string;
	details?: Record<string, unknown>;
	hint?: string;
	message: string;
}

/** The answer. */
export type IpcResponse =
	| { error: IpcFailure; ok: false; type: "response" }
	| { ok: true; result: Record<string, unknown>; type: "response" };

const jsonLine = type("string.json.parse");
const RECORD = "Record<string, unknown>";

const helloLine = jsonLine.pipe(type({ protocol: "number", token: "string", type: "'hello'" }));

const requestLine = jsonLine.pipe(
	type({
		"method": "'shutdown' | 'status' | 'sync'",
		"params?": RECORD,
		"type": "'request'",
	}),
);

const responseLine = jsonLine.pipe(
	type.or(
		{ ok: "true", result: RECORD, type: "'response'" },
		{
			error: {
				"code": "string",
				"details?": RECORD,
				"hint?": "string",
				"message": "string",
			},
			ok: "false",
			type: "'response'",
		},
	),
);

/**
 * One message as a line.
 *
 * @param message - A hello, request, or response.
 * @returns JSON text and a newline.
 */
export function encodeLine(message: IpcHello | IpcRequest | IpcResponse): string {
	return `${JSON.stringify(message)}\n`;
}

/**
 * Read a hello line.
 *
 * @param line - The line, without its newline.
 * @returns The hello, or `undefined` when the line is not one.
 */
export function parseHello(line: string): IpcHello | undefined {
	const parsed = helloLine(line);
	return parsed instanceof type.errors ? undefined : parsed;
}

/**
 * Read a request line.
 *
 * @param line - The line, without its newline.
 * @returns The request, or `undefined` when the line is not one.
 */
export function parseRequest(line: string): IpcRequest | undefined {
	const parsed = requestLine(line);
	if (parsed instanceof type.errors) {
		return undefined;
	}

	return { method: parsed.method, params: parsed.params ?? {}, type: "request" };
}

/**
 * Read a response line.
 *
 * @param line - The line, without its newline.
 * @returns The response, or `undefined` when the line is not one.
 */
export function parseResponse(line: string): IpcResponse | undefined {
	const parsed = responseLine(line);
	return parsed instanceof type.errors ? undefined : parsed;
}
