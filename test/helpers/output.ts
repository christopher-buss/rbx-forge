import { type } from "arktype";
import { assert } from "vitest";

import type { OutputStreams } from "../../src/seams/reporter.ts";

const resultLine = type({
	"command": "string | null",
	"data?": "Record<string, unknown>",
	"error?": {
		"code": "string",
		"details?": "Record<string, unknown>",
		"hint?": "string",
		"message": "string",
	},
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
 * Parse NDJSON output, one value per line. Fails on a line that is not JSON.
 *
 * @param stdout - The output.
 * @returns One value per line.
 */
export function parseLines(stdout: string): Array<unknown> {
	return stdout
		.split("\n")
		.filter((line) => line !== "")
		.map((line): unknown => JSON.parse(line));
}

/**
 * Parse the last NDJSON line of some output as a result object.
 *
 * @param stdout - The output.
 * @returns The result, checked against its shape.
 */
export function parseResult(stdout: string): ResultLine {
	const parsed = resultLine(parseLines(stdout).at(-1));
	assert(!(parsed instanceof type.errors), "the last line is a result object");
	return parsed;
}

/**
 * Make output streams that record every write.
 *
 * @returns The streams and readers for what they got.
 */
export function captureOutput(): CapturedOutput {
	let stdout = "";
	let stderr = "";

	return {
		jsonLines: () => parseLines(stdout),
		output: {
			stderr: (text) => {
				stderr += text;
			},
			stdout: (text) => {
				stdout += text;
			},
		},
		result: () => parseResult(stdout),
		stderr: () => stderr,
		stdout: () => stdout,
	};
}

const openedSnapshot = type({
	place: "string",
	studio: type({ pid: "number" }).or("null"),
});

/** What `forge open --json` reports: the snapshot and its Studio. */
export type OpenedSnapshot = typeof openedSnapshot.infer;

/**
 * Read the snapshot and its Studio from `forge open`'s result data.
 *
 * @param data - The result's data.
 * @returns The snapshot's path, and the Studio forge started (`null` for
 *   the platform launcher).
 */
export function parseOpened(data: unknown): OpenedSnapshot {
	const parsed = openedSnapshot(data);
	assert(!(parsed instanceof type.errors), "the data names the snapshot and its Studio");
	return parsed;
}
