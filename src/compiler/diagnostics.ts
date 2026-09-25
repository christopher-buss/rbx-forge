import { stripVTControlCharacters } from "node:util";

/** One compiler error or warning. */
export interface Diagnostic {
	/** Such as `TS2322`, or `roblox-ts` for a roblox-ts check. */
	code: string;
	/** 1-based; `null` when the diagnostic has no location. */
	column: null | number;
	/** As the compiler wrote it, usually relative to the project root. */
	file: null | string;
	/** 1-based; `null` when the diagnostic has no location. */
	line: null | number;
	/** Every line of the message, without the code frame. */
	message: string;
	severity: "error" | "warning";
}

/** What one compile reported. */
export interface CompileReport {
	diagnostics: Array<Diagnostic>;
	/** The error count: from the summary line when there is one. */
	errors: number;
}

/** Reads compiler output line by line. */
export interface DiagnosticsParser {
	/**
	 * Read the report of diagnostics since the last summary line. A one-shot
	 * compile prints no summary line, so this is its whole report.
	 */
	finish: () => CompileReport;
	/**
	 * Read one output line.
	 *
	 * @returns The report of the compile a watch-mode summary line (`Found 2
	 *   errors.`) ends, else `undefined`.
	 */
	read: (line: string) => CompileReport | undefined;
}

// `src/a.ts:3:7 - error TS2322: message` (pretty, what rbxtsc prints).
const PRETTY = /^(?<file>.+?):(?<line>\d+):(?<column>\d+) - (?<rest>(?:error|warning) TS.*)$/;
// `src/a.ts(3,7): error TS2322: message` (plain).
const PLAIN = /^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\): (?<rest>(?:error|warning) TS.*)$/;
// `error TS2322: message`; roblox-ts writes its own code as `TS roblox-ts`.
const HEADER = /^(?<severity>error|warning) TS ?(?<code>[^\s:]+): (?<message>.*)$/;
// `[10:00:00] Found 2 errors. Watching for file changes.`, or tsc's
// `Found 2 errors in 2 files.`
const SUMMARY = /^(?:\[[^\]]*\] |[\d:]+(?: [AP]M)? - )?Found (?<count>\d+) errors?\b/;
const NUMERIC_CODE = /^\d+$/;

interface ParserState {
	/** The diagnostic whose message lines are being read. */
	current: Diagnostic | undefined;
	/** Diagnostics of the current compile, in order. */
	diagnostics: Array<Diagnostic>;
}

/**
 * A parser for the output of rbxtsc (and tsc). A diagnostic is its first
 * line plus every line up to the next blank line, so a message that spans
 * lines stays whole and the code frame after the blank line is left out.
 * Colors and carriage returns are stripped first.
 *
 * @returns A parser with no diagnostics read.
 */
export function createDiagnosticsParser(): DiagnosticsParser {
	const state: ParserState = { current: undefined, diagnostics: [] };
	return {
		finish: () => take(state),
		read: (line) => readLine(state, line),
	};
}

function close(state: ParserState): void {
	if (state.current === undefined) {
		return;
	}

	state.diagnostics.push(state.current);
	state.current = undefined;
}

/**
 * End the current compile.
 *
 * @param state - The parser.
 * @param errors - The count a summary line gave, if any.
 * @returns Its report; the parser starts over with no diagnostics.
 */
function take(state: ParserState, errors?: number): CompileReport {
	close(state);
	const { diagnostics } = state;
	state.diagnostics = [];
	return {
		diagnostics,
		errors: errors ?? diagnostics.filter(({ severity }) => severity === "error").length,
	};
}

/**
 * A diagnostic's first line with its location split off.
 *
 * @param text - The line, without colors.
 * @returns The diagnostic so far, or `undefined` when the line does not
 *   start one.
 */
function readHeader(text: string): Diagnostic | undefined {
	const located = PRETTY.exec(text)?.groups ?? PLAIN.exec(text)?.groups;
	const header = HEADER.exec(located?.["rest"] ?? text)?.groups;
	if (header === undefined) {
		return undefined;
	}

	// Every group of a match holds text; `String` only narrows the type.
	const code = String(header["code"]);
	return {
		code: NUMERIC_CODE.test(code) ? `TS${code}` : code,
		column: located === undefined ? null : Number(located["column"]),
		file: located?.["file"] ?? null,
		line: located === undefined ? null : Number(located["line"]),
		message: String(header["message"]),
		severity: header["severity"] === "warning" ? "warning" : "error",
	};
}

/**
 * Read a line that is not a summary line: it starts a diagnostic, ends one
 * (a blank line), adds to the current one's message, or is not part of one.
 *
 * @param state - The parser.
 * @param text - The line, without colors.
 */
function readText(state: ParserState, text: string): void {
	const header = readHeader(text);
	if (header !== undefined || text === "") {
		close(state);
		state.current = header;
	} else if (state.current !== undefined) {
		state.current.message = `${state.current.message}\n${text}`;
	}
}

function readLine(state: ParserState, line: string): CompileReport | undefined {
	const text = stripVTControlCharacters(line).trimEnd();
	const count = SUMMARY.exec(text)?.groups?.["count"];
	let report: CompileReport | undefined;
	if (count === undefined) {
		readText(state, text);
	} else {
		report = take(state, Number(count));
	}

	return report;
}
