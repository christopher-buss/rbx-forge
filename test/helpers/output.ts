import { type } from "arktype";
import { assert } from "vitest";

import type { OutputStreams } from "../../src/seams/reporter.ts";

const resultLine = type({
	"command": "string | null",
	"data?": "Record<string, unknown>",
	"error?": { "code": "string", "hint?": "string", "message": "string" },
	"exitCode?": "number",
	"ok": "boolean",
	"type": "'result'",
});

/** The final NDJSON line of a run. */
export type ResultLine = typeof resultLine.infer;

/** Output streams that record what was written. */
export interface CapturedOutput {
	/** Parse stdout as NDJSON, one value per line. */
	jsonLines: () => Array<unknown>;
	output: OutputStreams;
	/** The last NDJSON line, checked to be a result object. */
	result: () => ResultLine;
	stderr: () => string;
	stdout: () => string;
}

/**
 * Make output streams that record every write.
 *
 * @returns The streams and readers for what they got.
 */
export function captureOutput(): CapturedOutput {
	let stdout = "";
	let stderr = "";

	function jsonLines(): Array<unknown> {
		return stdout
			.split("\n")
			.filter((line) => line !== "")
			.map((line): unknown => JSON.parse(line));
	}

	return {
		jsonLines,
		output: {
			stderr: (text) => {
				stderr += text;
			},
			stdout: (text) => {
				stdout += text;
			},
		},
		result: () => {
			const parsed = resultLine(jsonLines().at(-1));
			assert(!(parsed instanceof type.errors), "the last line is a result object");
			return parsed;
		},
		stderr: () => stderr,
		stdout: () => stdout,
	};
}
