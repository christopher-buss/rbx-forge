import { type } from "arktype";

import type { CompileEvent, Diagnostic } from "./diagnostics.ts";
import { createDiagnosticsParser } from "./diagnostics.ts";

/**
 * A line of sloptor's watch-mode output (`sloptor build -w --json`): a JSON
 * object with a string `event` field.
 */
const eventLine = type("string.json.parse").pipe(type({ event: "string" }));

/** A diagnostic as sloptor writes it: no location is `""` and `0`. */
const sloptorDiagnostic = type({
	"code?": "string",
	"col": "number.integer",
	"file": "string",
	"line": "number.integer",
	"message": "string",
	"severity": "'error' | 'warning'",
});

const sloptorEvent = type({ event: "'buildStart'" }).or({
	diagnostics: sloptorDiagnostic.array(),
	event: "'buildEnd'",
});

/** A line that may be JSON: the rest are rbxtsc text for sure. */
const JSON_OBJECT_START = /^\s*\{/;

/**
 * Read watch-mode compiler output line by line as build events. A line that
 * is a JSON object with a string `event` field is a sloptor event; every
 * other line is rbxtsc text for the rbxtsc parser.
 *
 * @returns A reader that gives the build event of each line, or
 *   `undefined` for any other line.
 */
export function createWatchEventReader(): (line: string) => CompileEvent | undefined {
	const parser = createDiagnosticsParser();
	return (line) => {
		const sloptor = readSloptorLine(line);
		return sloptor === undefined ? parser.read(line) : sloptor.event;
	};
}

function toDiagnostic({
	code,
	col,
	file,
	line,
	message,
	severity,
}: typeof sloptorDiagnostic.infer): Diagnostic {
	const hasLocation = line > 0;
	return {
		code: code ?? "",
		column: hasLocation ? col : null,
		file: file === "" ? null : file,
		line: hasLocation ? line : null,
		message,
		severity,
	};
}

function toCompileEvent(event: typeof sloptorEvent.infer): CompileEvent {
	if (event.event === "buildStart") {
		return { type: "start" };
	}

	const diagnostics = event.diagnostics.map(toDiagnostic);
	const errors = diagnostics.filter(({ severity }) => severity === "error").length;
	return { report: { diagnostics, errors }, type: "end" };
}

/**
 * Read one line as a sloptor event.
 *
 * @param line - The output line; a trailing `\r` is stripped first.
 * @returns `undefined` for a line that is not a sloptor event; else its build
 *   event, `undefined` for an event forge does not read (such as `watching`)
 *   or one with the wrong fields.
 */
function readSloptorLine(line: string): undefined | { event: CompileEvent | undefined } {
	const text = line.endsWith("\r") ? line.slice(0, -1) : line;
	const value = JSON_OBJECT_START.test(text) ? eventLine(text) : undefined;
	if (value === undefined || value instanceof type.errors) {
		return undefined;
	}

	const event = sloptorEvent(value);
	return { event: event instanceof type.errors ? undefined : toCompileEvent(event) };
}
