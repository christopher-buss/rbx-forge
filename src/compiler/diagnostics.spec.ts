import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { CompileReport } from "./diagnostics.ts";
import { createDiagnosticsParser } from "./diagnostics.ts";

/**
 * Output of roblox-ts 3.0.0 (`rbxtsc`), recorded on Windows: ANSI colors,
 * and CRLF on some lines only.
 */
const FIXTURES = path.join(import.meta.dirname, "..", "..", "test", "fixtures", "rbxtsc");

function recorded(name: string): Array<string> {
	return readFileSync(path.join(FIXTURES, name), "utf8").split("\n");
}

/**
 * Feed every line to one parser.
 *
 * @param lines - The output lines.
 * @returns The report each summary line gave, then the final report.
 */
function parseAll(lines: ReadonlyArray<string>): {
	final: CompileReport;
	summaries: Array<CompileReport>;
} {
	const parser = createDiagnosticsParser();
	const summaries = lines
		.map((line) => parser.read(line))
		.flatMap((event) => (event?.type === "end" ? [event.report] : []));

	return { final: parser.finish(), summaries };
}

describe(createDiagnosticsParser, () => {
	it("should read TypeScript errors with their location and code", () => {
		expect.assertions(1);

		expect(parseAll(recorded("type-errors.txt"))).toStrictEqual({
			final: {
				diagnostics: [
					{
						code: "TS2322",
						column: 7,
						file: "src/shared/module.ts",
						line: 1,
						message: "Type 'string' is not assignable to type 'number'.",
						severity: "error",
					},
					{
						code: "TS2552",
						column: 13,
						file: "src/shared/module.ts",
						line: 3,
						message: "Cannot find name 'undefinedName'. Did you mean 'undefined'?",
						severity: "error",
					},
					{
						code: "TS2322",
						column: 14,
						file: "src/shared/other.ts",
						line: 1,
						message: "Type 'number' is not assignable to type 'string'.",
						severity: "error",
					},
				],
				errors: 3,
			},
			summaries: [],
		});
	});

	it("should read roblox-ts errors with every line of their message", () => {
		expect.assertions(1);

		expect(parseAll(recorded("roblox-ts-errors.txt")).final).toStrictEqual({
			diagnostics: [
				{
					code: "roblox-ts",
					column: 18,
					file: "src/shared/module.ts",
					line: 5,
					message:
						"`typeof` operator is not supported!\nSuggestion: Use `typeIs(value, type)` or `typeOf(value)` instead.",
					severity: "error",
				},
				{
					code: "roblox-ts",
					column: 18,
					file: "src/shared/module.ts",
					line: 6,
					message: "`null` is not supported!\nSuggestion: Use `undefined` instead.",
					severity: "error",
				},
			],
			errors: 2,
		});
	});

	it("should read an error with no location", () => {
		expect.assertions(1);

		expect(parseAll(recorded("project-error.txt")).final).toStrictEqual({
			diagnostics: [
				{
					code: "roblox-ts",
					column: null,
					file: null,
					line: null,
					message: "Non-package projects must have a Rojo project file!",
					severity: "error",
				},
			],
			errors: 1,
		});
	});

	it("should find nothing in the output of a clean compile", () => {
		expect.assertions(1);

		expect(parseAll(recorded("success.txt"))).toStrictEqual({
			final: { diagnostics: [], errors: 0 },
			summaries: [],
		});
	});

	it("should end a watch-mode compile at its summary line", () => {
		expect.assertions(2);

		const { final, summaries } = parseAll(recorded("watch.txt"));

		expect(
			summaries.map(({ diagnostics, errors }) => {
				return { errors, lines: diagnostics.map(({ line }) => line) };
			}),
		).toStrictEqual([{ errors: 2, lines: [5, 6] }]);
		expect(final).toStrictEqual({ diagnostics: [], errors: 0 });
	});

	it("should take the error count from the summary line", () => {
		expect.assertions(1);

		const { summaries } = parseAll([
			"src/a.ts:1:1 - error TS1005: ';' expected.",
			"Found 4 errors in 2 files.",
		]);

		expect(summaries).toStrictEqual([
			{ diagnostics: [expect.objectContaining({ code: "TS1005" })], errors: 4 },
		]);
	});

	it.for([
		["[10:00:00] Found 1 error. Watching for file changes.", 1],
		["10:00:00 AM - Found 0 errors. Watching for file changes.", 0],
		["Found 2 errors in the same file, starting at: src/a.ts:3", 2],
		["Found 1 error in src/a.ts:3", 1],
	] as const)("should read the summary line %j", ([line, errors]) => {
		expect.assertions(1);

		expect(parseAll([line]).summaries).toStrictEqual([{ diagnostics: [], errors }]);
	});

	it("should not take a message line that mentions a count for a summary", () => {
		expect.assertions(1);

		expect(parseAll(["error TS roblox-ts: Found 3 errors in the plugin"])).toStrictEqual({
			final: {
				diagnostics: [expect.objectContaining({ message: "Found 3 errors in the plugin" })],
				errors: 1,
			},
			summaries: [],
		});
	});

	it("should read the plain format and its indented message chain", () => {
		expect.assertions(1);

		expect(
			parseAll([
				"src/a.ts(4,10): error TS2322: Type '{ a: number; }' is not assignable to type 'B'.",
				"  Property 'b' is missing in type '{ a: number; }'.",
				"src/b.ts(1,1): warning TS6133: 'x' is declared but its value is never read.",
			]).final,
		).toStrictEqual({
			diagnostics: [
				{
					code: "TS2322",
					column: 10,
					file: "src/a.ts",
					line: 4,
					message:
						"Type '{ a: number; }' is not assignable to type 'B'.\n  Property 'b' is missing in type '{ a: number; }'.",
					severity: "error",
				},
				{
					code: "TS6133",
					column: 1,
					file: "src/b.ts",
					line: 1,
					message: "'x' is declared but its value is never read.",
					severity: "warning",
				},
			],
			errors: 1,
		});
	});

	it("should count warnings as diagnostics but not as errors", () => {
		expect.assertions(1);

		expect(
			parseAll(["C:/game/src/a.ts:2:3 - warning TS roblox-ts: Unused import."]).final,
		).toStrictEqual({
			diagnostics: [
				{
					code: "roblox-ts",
					column: 3,
					file: "C:/game/src/a.ts",
					line: 2,
					message: "Unused import.",
					severity: "warning",
				},
			],
			errors: 0,
		});
	});

	it("should ignore lines outside a diagnostic", () => {
		expect.assertions(1);

		expect(
			parseAll(["compiling as game..", "", "  indented text", "error: not a diagnostic"])
				.final,
		).toStrictEqual({ diagnostics: [], errors: 0 });
	});

	it("should end a diagnostic at a start line", () => {
		expect.assertions(1);

		const { final } = parseAll([
			"src/a.ts:1:1 - error TS1005: ';' expected.",
			"[10:00:00] File change detected. Starting incremental compilation...",
		]);

		expect(final.diagnostics).toStrictEqual([
			expect.objectContaining({ message: "';' expected." }),
		]);
	});

	it.for([
		"\u001B[90m[\u001B[0m04:52:31\u001B[0m] Starting compilation in watch mode...\r",
		"[\u001B[90m21:32:12\u001B[0m] File change detected. Starting incremental compilation...\r",
		"10:00:00 AM - File change detected. Starting incremental compilation...",
		"[10:00:00] tsconfig change detected (tsconfig.json) \u2014 reloading...",
	])("should take %j for a start line", (line) => {
		expect.assertions(1);

		expect(createDiagnosticsParser().read(line)).toStrictEqual({ type: "start" });
	});

	it.for([
		"compiling as game..",
		"src/a.ts:1:1 - error TS1005: File change detected. Starting incremental compilation...",
		"",
	])("should not take %j for a start line", (line) => {
		expect.assertions(1);

		expect(createDiagnosticsParser().read(line)).toBeUndefined();
	});
});
