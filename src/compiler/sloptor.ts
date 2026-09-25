import { type } from "arktype";

import type { CompileEvent, CompileReport, Diagnostic, DiagnosticsParser } from "./diagnostics.ts";
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
	"diagnostics": sloptorDiagnostic.array(),
	"event": "'buildEnd'",
	"ok?": "boolean",
});

/**
 * The one object `sloptor build --json` prints for a one-shot build. Forge
 * reads `ok` and `diagnostics`; `version`, `files`, and `durationMs` are
 * there too.
 */
const sloptorResult = type({ diagnostics: sloptorDiagnostic.array(), ok: "boolean" });

/** A line that may be JSON: the rest are rbxtsc text for sure. */
const JSON_OBJECT_START = /^\s*\{/;

interface OutputState {
	/** The rbxtsc parser, for every line that is not sloptor's. */
	parser: DiagnosticsParser;
	/** The report of a one-shot sloptor result, once one came. */
	result: CompileReport | undefined;
}

/**
 * A parser for the output of rbxtsc or sloptor, found line by line. A JSON
 * object with a string `event` field is a sloptor watch-mode event
 * (`sloptor build -w --json`); a JSON object with `ok` and `diagnostics` is
 * the result of a one-shot `sloptor build --json`; every other line is
 * rbxtsc text. A trailing `\r` is JSON whitespace, so CRLF output parses as
 * it is.
 *
 * @returns A parser with no diagnostics read. Its `finish` gives the report
 *   of the last one-shot sloptor result, else what rbxtsc text reported.
 */
export function createCompilerOutputParser(): DiagnosticsParser {
	const state: OutputState = { parser: createDiagnosticsParser(), result: undefined };
	return {
		finish: () => finish(state),
		read: (line) => readLine(state, line),
	};
}

function finish(state: OutputState): CompileReport {
	const text = state.parser.finish();
	const { result } = state;
	state.result = undefined;
	return result ?? text;
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

/**
 * The report of a sloptor build.
 *
 * @param build - Its diagnostics, and whether it succeeded.
 * @returns The report. A failed build counts at least one error, so it never
 *   looks clean.
 */
function toReport({
	diagnostics,
	ok,
}: {
	diagnostics: Array<typeof sloptorDiagnostic.infer>;
	ok?: boolean;
}): CompileReport {
	const mapped = diagnostics.map(toDiagnostic);
	const errors = mapped.filter(({ severity }) => severity === "error").length;
	return { diagnostics: mapped, errors: ok === false ? Math.max(errors, 1) : errors };
}

function toCompileEvent(event: typeof sloptorEvent.infer): CompileEvent {
	return event.event === "buildStart"
		? { type: "start" }
		: { report: toReport(event), type: "end" };
}

/**
 * Read one line: a sloptor event, a sloptor result, or rbxtsc text.
 *
 * @param state - The parser.
 * @param line - The output line.
 * @returns The build event; `undefined` for other output, and for a sloptor
 *   event forge does not read (such as `watching`) or one with the wrong
 *   fields.
 */
function readLine(state: OutputState, line: string): CompileEvent | undefined {
	const value = JSON_OBJECT_START.test(line) ? jsonText(line) : undefined;
	if (anyEvent.allows(value)) {
		const event = sloptorEvent(value);
		return event instanceof type.errors ? undefined : toCompileEvent(event);
	}

	const result = sloptorResult(value);
	if (result instanceof type.errors) {
		return state.parser.read(line);
	}

	state.result = toReport(result);
	return undefined;
}
