import { type } from "arktype";

import type { CompileEvent, Diagnostic, DiagnosticsParser } from "./diagnostics.ts";
import { createDiagnosticsParser } from "./diagnostics.ts";

const jsonText = type("string.json.parse");

/**
 * A line of sloptor's watch-mode output (`sloptor build -w --json`): a JSON
 * object with a string `event` field.
 */
const anyEvent = type({ event: "string" });

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
 * other line is rbxtsc text for the rbxtsc parser. A trailing `\r` is JSON
 * whitespace, so CRLF output parses as it is.
 *
 * @returns A reader that gives the build event of each line, or
 *   `undefined` for any other line.
 */
export function createWatchEventReader(): (line: string) => CompileEvent | undefined {
	const parser = createDiagnosticsParser();
	return (line) => readLine(parser, line);
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
 * Read one line: a sloptor event, or rbxtsc text.
 *
 * @param parser - The rbxtsc parser, for every line that is not an event.
 * @param line - The output line.
 * @returns The build event; `undefined` for other output, and for a sloptor
 *   event forge does not read (such as `watching`) or one with the wrong
 *   fields.
 */
function readLine(parser: DiagnosticsParser, line: string): CompileEvent | undefined {
	const value = JSON_OBJECT_START.test(line) ? jsonText(line) : undefined;
	if (value === undefined || value instanceof type.errors) {
		return parser.read(line);
	}

	const event = sloptorEvent(value);
	if (!(event instanceof type.errors)) {
		return toCompileEvent(event);
	}

	return anyEvent.allows(value) ? undefined : parser.read(line);
}
