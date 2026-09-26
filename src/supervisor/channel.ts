import type { Type } from "arktype";
import { type } from "arktype";

import type { ConfigLayer } from "../config/schema.ts";
import { validateConfigLayer } from "../config/schema.ts";
import type { ForgeErrorCode } from "../errors.ts";
import { ERROR_CODES, ForgeError } from "../errors.ts";
import type { Reporter, ReporterEvent } from "../seams/reporter.ts";
import { STOP_SIGNALS } from "../seams/signals.ts";
import type { StopRequest } from "../session/stop-source.ts";

/**
 * The channel between `forge start` (the owner) and its supervisor. All of it
 * rides on pipes the supervisor gets at creation:
 *
 * - argv: the {@link SessionRequest}, as JSON.
 * - stdin, the owner pipe: `{"type":"stop","signal":…}` lines when `start`
 *   gets a stop signal. EOF means `start` is gone. Either way, the parts
 *   `start` owns stop, and the session ends unless a part with no owner is
 *   left.
 * - stdout: {@link SupervisorMessage} lines: progress events, then one
 *   result; or `released` once the session goes on without `start`.
 */

/** What session `start` or `up` asks for. */
export interface SessionRequest {
	/** `--no-compiler` sets it to `false`. */
	compiler: boolean;
	/** The config values its flags set (the top config layer). */
	config: ConfigLayer;
	/**
	 * Set by `forge up`: the supervisor has no owner pipe and outlives its
	 * caller. It writes its messages to `report` until the session is
	 * ready, and then deletes it.
	 */
	detached?: { report: string };
	/**
	 * `--force`: an earlier session whose processes outlive the barrier's
	 * bound is cleaned up by force.
	 */
	force?: boolean;
	/** `start --no-open` sets it to `false`; `up` never opens Studio. */
	open: boolean;
	/** Serve Rojo: `start` does, `up` does not. */
	rojo: boolean;
}

/** A failed session, as the supervisor reports it. */
export interface SupervisorFailure {
	code: string;
	details?: Readonly<Record<string, unknown>>;
	hint?: string;
	message: string;
}

/** One line from the supervisor. */
export type SupervisorMessage =
	| { data: Readonly<Record<string, unknown>>; ok: true; summary: string; type: "result" }
	/** `start` let go of the session, which goes on without it. */
	| { data: Readonly<Record<string, unknown>>; summary: string; type: "released" }
	| { error: SupervisorFailure; ok: false; type: "result" }
	| { event: ReporterEvent; type: "event" };

const RECORD = "Record<string, unknown>";

/** One line of JSON text, parsed. */
const jsonLine = type("string.json.parse");

const diagnostic = type({
	code: "string",
	column: "number.integer | null",
	file: "string | null",
	line: "number.integer | null",
	message: "string",
	severity: "'error' | 'warning'",
});

const event: Type<ReporterEvent> = type.or(
	{ diagnostics: diagnostic.array(), errors: "number.integer", type: "'compiled'" },
	{ message: "string", type: "'info' | 'warning'" },
	{ line: "string", service: "string", type: "'log'" },
	{ name: "string", status: "'failed' | 'started' | 'succeeded'", type: "'step'" },
);

const messageSchema: Type<SupervisorMessage> = type.or(
	{ event, type: "'event'" },
	{ data: RECORD, ok: "true", summary: "string", type: "'result'" },
	{ data: RECORD, summary: "string", type: "'released'" },
	{
		error: {
			"code": "string",
			"details?": RECORD,
			"hint?": "string",
			"message": "string",
		},
		ok: "false",
		type: "'result'",
	},
);

const messageLine = jsonLine.pipe(messageSchema);

/** The code of every failure that is a bug in forge. */
const INTERNAL_ERROR: ForgeErrorCode = "internal_error";

const requestSchema = jsonLine.pipe(
	type({
		"compiler": "boolean",
		"config": "object",
		"detached?": { report: "string" },
		"force?": "boolean",
		"open": "boolean",
		"rojo": "boolean",
	}),
);

const stopLine = jsonLine.pipe(type({ signal: type.enumerated(...STOP_SIGNALS), type: "'stop'" }));

/**
 * Write the session request for the supervisor's argv.
 *
 * @param request - What `start` asks for.
 * @returns JSON text.
 */
export function encodeSessionRequest(request: SessionRequest): string {
	return JSON.stringify(request);
}

/**
 * Read the session request from the supervisor's argv.
 *
 * @param text - The argument.
 * @returns The request, with its config layer validated.
 * @throws {ForgeError} `internal_error` when it is not one: only `start`
 *   writes it.
 */
export function parseSessionRequest(text: string | undefined): SessionRequest {
	const parsed = requestSchema(text);
	if (parsed instanceof type.errors) {
		throw new ForgeError(
			INTERNAL_ERROR,
			`The supervisor got no session request: ${parsed.summary}`,
		);
	}

	const config = validateConfigLayer(parsed.config, (problems) => {
		const lines = problems.map(({ message, path }) => `${path}: ${message}`);
		return new ForgeError(
			INTERNAL_ERROR,
			`The session request's config is invalid:\n${lines.join("\n")}`,
		);
	});
	return {
		compiler: parsed.compiler,
		config,
		...(parsed.detached === undefined ? {} : { detached: parsed.detached }),
		open: parsed.open,
		rojo: parsed.rojo,
		...(parsed.force === true ? { force: true } : {}),
	};
}

/**
 * Write a stop request for the owner pipe.
 *
 * @param signal - The stop signal `start` got.
 * @returns One line.
 */
export function encodeStop(signal: NodeJS.Signals): string {
	return `${JSON.stringify({ signal, type: "stop" })}\n`;
}

/**
 * Read one line of the owner pipe.
 *
 * @param line - The line, without its newline.
 * @returns The stop request, or `undefined` when the line is not one.
 */
export function parseOwnerLine(line: string): StopRequest | undefined {
	const parsed = stopLine(line);
	return parsed instanceof type.errors ? undefined : { signal: parsed.signal, type: "signal" };
}

/**
 * Write one supervisor message.
 *
 * @param message - The event or the result.
 * @returns One line.
 */
export function encodeMessage(message: SupervisorMessage): string {
	return `${JSON.stringify(message)}\n`;
}

/**
 * Read one line of the supervisor's stdout.
 *
 * @param line - The line, without its newline.
 * @returns The message, or `undefined` when the line is not one.
 */
export function parseMessage(line: string): SupervisorMessage | undefined {
	const parsed = messageLine(line);
	return parsed instanceof type.errors ? undefined : parsed;
}

/**
 * The supervisor's reporter: every event, and then the result, goes to
 * `start` as one {@link SupervisorMessage} line.
 *
 * @param write - Writes to the supervisor's stdout.
 * @returns A reporter that writes message lines.
 */
export function createChannelReporter(write: (text: string) => void): Reporter {
	return {
		emit: (reported) => {
			write(encodeMessage({ event: reported, type: "event" }));
		},
		fail: ({ code, details, hint, message }) => {
			const error: SupervisorFailure = {
				code,
				message,
				...(details === undefined ? {} : { details }),
				...(hint === undefined ? {} : { hint }),
			};
			write(encodeMessage({ error, ok: false, type: "result" }));
		},
		succeed: (_command, { data, summary }) => {
			write(encodeMessage({ data, ok: true, summary, type: "result" }));
		},
	};
}

/**
 * The error a failure result stands for.
 *
 * @param failure - The supervisor's failure.
 * @returns The same error; an unknown code becomes `internal_error`.
 */
export function failureError({ code, details, hint, message }: SupervisorFailure): ForgeError {
	return new ForgeError(isErrorCode(code) ? code : INTERNAL_ERROR, message, { details, hint });
}

function isErrorCode(code: string): code is ForgeErrorCode {
	return Object.hasOwn(ERROR_CODES, code);
}
