import type { Diagnostic } from "../compiler/diagnostics.ts";
import type { OutputStreams, Reporter, ReporterEvent } from "../seams/reporter.ts";

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
 * Diagnostics one compile shows in the TTY view. The view never redraws: it
 * adds one bounded block per compile, and the compiler log has the rest.
 */
export const COMPILE_VIEW_LINES = 20;

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describeDiagnostic({ code, column, file, line, message, severity }: Diagnostic): string {
	const location = file === null ? "" : `${file}:${String(line)}:${String(column)} `;
	const [first] = message.split("\n");
	return `  ${location}${severity} ${code}: ${String(first)}`;
}

/**
 * The TTY lines of one watch-mode compile: a summary, then at most
 * {@link COMPILE_VIEW_LINES} diagnostics, one line each.
 *
 * @param event - The compile.
 * @returns The text to write.
 */
function renderCompiled({ diagnostics, errors }: Extract<ReporterEvent, { type: "compiled" }>): string {
	const warnings = diagnostics.length - errors;
	const mark = errors === 0 ? STEP_MARKS.succeeded : STEP_MARKS.failed;
	const shown = diagnostics.slice(0, COMPILE_VIEW_LINES).map(describeDiagnostic);
	const hidden = diagnostics.length - shown.length;
	const more = hidden > 0 ? [`  ... and ${hidden} more in the compiler log`] : [];
	const summary = `${mark} compiled: ${plural(errors, "error")}, ${plural(warnings, "warning")}`;
	return `${[summary, ...shown, ...more].join("\n")}\n`;
}

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
				case "compiled": {
					output.stdout(renderCompiled(event));
					break;
				}
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
