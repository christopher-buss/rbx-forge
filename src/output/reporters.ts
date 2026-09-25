import type { OutputStreams, Reporter } from "../seams/reporter.ts";

/**
 * A reporter that writes one JSON object per line to stdout: each event as it
 * happens, then one `{"type":"result"}` object. Agents parse this; it never
 * writes to stderr, so nothing interleaves with it.
 *
 * @param output - The process streams.
 * @returns The reporter.
 */
export function createJsonReporter(output: OutputStreams): Reporter {
	function line(value: object): void {
		output.stdout(`${JSON.stringify(value)}\n`);
	}

	return {
		emit: line,
		fail: ({ code, command, details, exitCode, hint, message }) => {
			line({
				type: "result",
				// `null`, not a missing key, when no command was read.
				command: command ?? null,
				error: { code, details, hint, message },
				exitCode,
				ok: false,
			});
		},
		succeed: (command, { data }) => {
			line({ type: "result", command, data, ok: true });
		},
	};
}

const STEP_MARKS = { failed: "✖", started: "›", succeeded: "✔" } as const;

/**
 * A reporter for a person at a terminal: short lines on stdout, warnings and
 * errors on stderr.
 *
 * @param output - The process streams.
 * @returns The reporter.
 */
export function createTtyReporter(output: OutputStreams): Reporter {
	return {
		emit: (event) => {
			switch (event.type) {
				case "info": {
					output.stdout(`${event.message}\n`);
					break;
				}
				case "step": {
					output.stdout(`${STEP_MARKS[event.status]} ${event.name}\n`);
					break;
				}
				case "warning": {
					output.stderr(`warning: ${event.message}\n`);
					break;
				}
			}
		},
		fail: ({ code, hint, message }) => {
			const hintLine = hint === undefined ? "" : `hint: ${hint}\n`;
			output.stderr(`forge: ${message} [${code}]\n${hintLine}`);
		},
		succeed: (_command, { summary }) => {
			output.stdout(`${summary}\n`);
		},
	};
}

/** What decides the output format of a run. */
export interface ReporterChoice {
	/** `--json` was passed. */
	json: boolean;
	/** stdout is a terminal. */
	stdoutIsTty: boolean;
}

/**
 * Pick the reporter for a run: NDJSON for `--json` or when stdout is not a
 * terminal, the TTY view otherwise.
 *
 * @param choice - The flag and terminal facts.
 * @param output - The process streams.
 * @returns The reporter.
 */
export function createReporter(
	{ json, stdoutIsTty }: ReporterChoice,
	output: OutputStreams,
): Reporter {
	return json || !stdoutIsTty ? createJsonReporter(output) : createTtyReporter(output);
}
