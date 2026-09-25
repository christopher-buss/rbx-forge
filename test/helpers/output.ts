import type { OutputStreams } from "../../src/seams/reporter.ts";

/** Output streams that record what was written. */
export interface CapturedOutput {
	/** Parse stdout as NDJSON, one value per line. */
	jsonLines: () => Array<unknown>;
	output: OutputStreams;
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

	return {
		jsonLines: () => {
			return stdout
				.split("\n")
				.filter((line) => line !== "")
				.map((line): unknown => JSON.parse(line));
		},
		output: {
			stderr: (text) => {
				stderr += text;
			},
			stdout: (text) => {
				stdout += text;
			},
		},
		stderr: () => stderr,
		stdout: () => stdout,
	};
}
