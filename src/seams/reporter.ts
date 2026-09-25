import type { Diagnostic } from "../compiler/diagnostics.ts";
import type { ForgeErrorCode } from "../errors.ts";
import type { ExitCode } from "../exit-codes.ts";

/**
 * The process streams, as plain write functions. The stdout stream carries the
 * product (the TTY view or NDJSON); stderr carries notices and TTY errors.
 */
export interface OutputStreams {
	stderr: (text: string) => void;
	stdout: (text: string) => void;
}

/**
 * Progress a command reports while it runs. Add a member to this union when a
 * command needs a new kind; both reporters must then render it.
 */
export type ReporterEvent =
	/** The watch-mode compiler finished one compile. */
	| { diagnostics: Array<Diagnostic>; errors: number; type: "compiled" }
	| { message: string; type: "info" }
	| { message: string; type: "warning" }
	| { name: string; status: "failed" | "started" | "succeeded"; type: "step" };

/** What a command returns when it succeeds. */
export interface CommandResult {
	/** The machine-readable result: the `data` of the final NDJSON line. */
	data: Readonly<Record<string, unknown>>;
	/** One line for the TTY view. */
	summary: string;
}

/** A failed run, as the final report shows it. */
export interface CommandFailure {
	code: ForgeErrorCode;
	/** The command that failed, or `undefined` when none was read. */
	command: string | undefined;
	/** Machine-readable facts, such as hook results; `--json` only. */
	details: Readonly<Record<string, unknown>> | undefined;
	exitCode: ExitCode;
	hint: string | undefined;
	message: string;
}

/**
 * Where a run reports progress and its outcome. `output/tty-reporter.ts`
 * writes a readable view; `output/json-reporter.ts` writes one NDJSON object
 * per event and a final `result` object. Unit tests pass a recorder
 * (`test/helpers/seams.ts`).
 */
export interface Reporter {
	/** Report progress. */
	emit: (event: ReporterEvent) => void;
	/** Report the outcome of a failed run. The last call of a run. */
	fail: (failure: CommandFailure) => void;
	/** Report the outcome of a successful command. The last call of a run. */
	succeed: (command: string, result: CommandResult) => void;
}
