import { describe, expect, it } from "vitest";

import type { CompileEvent } from "./diagnostics.ts";
import { createWatchEventReader } from "./sloptor.ts";

function readAll(lines: ReadonlyArray<string>): Array<CompileEvent | undefined> {
	const read = createWatchEventReader();
	return lines.map((line) => read(line));
}

function event(fields: Record<string, unknown>): string {
	return JSON.stringify(fields);
}

const START = event({ at: "2026-09-25T18:00:00.000Z", changed: [], event: "buildStart" });

describe(createWatchEventReader, () => {
	it("should read a sloptor buildStart as a start event", () => {
		expect.assertions(1);

		expect(readAll([START])).toStrictEqual([{ type: "start" }]);
	});

	it("should read a sloptor buildEnd with its diagnostics and error count", () => {
		expect.assertions(1);

		const end = event({
			diagnostics: [
				{
					code: "TS2322",
					col: 7,
					file: "src/a.ts",
					line: 3,
					message: "Type 'string' is not assignable to type 'number'.",
					severity: "error",
				},
				{
					code: "noAny",
					col: 1,
					file: "src/b.ts",
					line: 9,
					message: "No any.",
					severity: "warning",
				},
				{ col: 0, file: "", line: 0, message: "The build failed.", severity: "error" },
			],
			durationMs: 142,
			event: "buildEnd",
			files: 222,
			ok: false,
		});

		expect(readAll([end])).toStrictEqual([
			{
				report: {
					diagnostics: [
						{
							code: "TS2322",
							column: 7,
							file: "src/a.ts",
							line: 3,
							message: "Type 'string' is not assignable to type 'number'.",
							severity: "error",
						},
						{
							code: "noAny",
							column: 1,
							file: "src/b.ts",
							line: 9,
							message: "No any.",
							severity: "warning",
						},
						{
							code: "",
							column: null,
							file: null,
							line: null,
							message: "The build failed.",
							severity: "error",
						},
					],
					errors: 2,
				},
				type: "end",
			},
		]);
	});

	it("should strip a trailing carriage return before it parses an event", () => {
		expect.assertions(1);

		expect(readAll([`${START}\r`])).toStrictEqual([{ type: "start" }]);
	});

	it("should ignore a sloptor event it does not know", () => {
		expect.assertions(1);

		expect(readAll([event({ event: "watching", files: 12 })])).toStrictEqual([undefined]);
	});

	it("should ignore a sloptor event with the wrong fields, and not read it as text", () => {
		expect.assertions(1);

		const badEnd = event({ diagnostics: [{ file: "src/a.ts" }], event: "buildEnd" });

		expect(
			readAll([
				"src/a.ts:1:1 - error TS2322: Bad.",
				badEnd,
				event({ event: "buildEnd" }),
				"",
				"Found 1 error. Watching for file changes.",
			]),
		).toStrictEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			{
				report: {
					diagnostics: [
						{
							code: "TS2322",
							column: 1,
							file: "src/a.ts",
							line: 1,
							message: "Bad.",
							severity: "error",
						},
					],
					errors: 1,
				},
				type: "end",
			},
		]);
	});

	it("should read a line that is not valid JSON as rbxtsc text", () => {
		expect.assertions(1);

		expect(
			readAll([
				"src/a.ts:1:1 - error TS2322: Bad.",
				'{"event":"buildEnd",',
				"",
				"Found 1 error.",
			]).at(-1),
		).toStrictEqual({
			report: {
				diagnostics: [
					{
						code: "TS2322",
						column: 1,
						file: "src/a.ts",
						line: 1,
						message: 'Bad.\n{"event":"buildEnd",',
						severity: "error",
					},
				],
				errors: 1,
			},
			type: "end",
		});
	});

	it("should read a JSON line with no string event field as rbxtsc text", () => {
		expect.assertions(1);

		expect(
			readAll([
				"src/a.ts:1:1 - error TS2322: Bad.",
				'{ "event": 1 }',
				'["event"]',
				"",
				"Found 1 error.",
			]).at(-1),
		).toStrictEqual({
			report: {
				diagnostics: [
					{
						code: "TS2322",
						column: 1,
						file: "src/a.ts",
						line: 1,
						message: 'Bad.\n{ "event": 1 }\n["event"]',
						severity: "error",
					},
				],
				errors: 1,
			},
			type: "end",
		});
	});

	it("should read rbxtsc output as before", () => {
		expect.assertions(1);

		expect(
			readAll([
				"[10:00:00] File change detected. Starting incremental compilation...\r",
				"[10:00:01] Found 0 errors. Watching for file changes.\r",
			]),
		).toStrictEqual([
			{ type: "start" },
			{ report: { diagnostics: [], errors: 0 }, type: "end" },
		]);
	});
});
