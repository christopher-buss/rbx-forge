import type { ExitCode } from "./exit-codes.ts";
import {
	EXIT_CLEANUP_PENDING,
	EXIT_FAILURE,
	EXIT_IDENTITY_UNVERIFIED,
	EXIT_INTERRUPTED,
	EXIT_NEEDS_CONFIRMATION,
	EXIT_NOT_RUNNING,
	EXIT_USAGE,
} from "./exit-codes.ts";

/**
 * Stable error codes. They appear in `--json` results, so a code is never
 * renamed or reused; add a new one instead. Written out by hand because
 * `isolatedDeclarations` cannot export a type derived from a `satisfies`
 * constant.
 */
export type ForgeErrorCode =
	| "cleanup_in_progress"
	| "cleanup_unverifiable"
	| "command_unavailable"
	| "compiler_missing"
	| "config_exists"
	| "config_invalid"
	| "config_load_failed"
	| "config_not_found"
	| "config_removed_key"
	| "declined"
	| "detach_unsupported"
	| "hook_depth_exceeded"
	| "hook_failed"
	| "identity_mismatch"
	| "internal_error"
	| "interrupted"
	| "needs_confirmation"
	| "not_running"
	| "port_in_use"
	| "previous_generation_alive"
	| "process_failed"
	| "reaper_unavailable"
	| "rojo_missing"
	| "service_failed"
	| "session_replaced"
	| "session_running"
	| "supervisor_unresponsive"
	| "syncback_unsupported"
	| "usage";

/** What an error code means and the exit code it maps to. */
export interface ErrorCodeInfo {
	exitCode: ExitCode;
	/** One line: when forge reports this code. */
	text: string;
}

/**
 * Every error code, its exit code, and its meaning. A new code does not compile
 * until it has a row here.
 */
export const ERROR_CODES: Readonly<Record<ForgeErrorCode, ErrorCodeInfo>> = {
	cleanup_in_progress: {
		exitCode: EXIT_CLEANUP_PENDING,
		text: "Workers of the session are still alive after the wait bound.",
	},
	cleanup_unverifiable: {
		exitCode: EXIT_IDENTITY_UNVERIFIED,
		text: "Forced cleanup found processes it could not verify, so it did not kill them.",
	},
	command_unavailable: {
		exitCode: EXIT_FAILURE,
		text: "The command does not apply to this project type.",
	},
	compiler_missing: { exitCode: EXIT_FAILURE, text: "The compiler is not installed." },
	config_exists: {
		exitCode: EXIT_FAILURE,
		text: "`init` found a config file it will not replace.",
	},
	config_invalid: { exitCode: EXIT_FAILURE, text: "The config file failed validation." },
	config_load_failed: {
		exitCode: EXIT_FAILURE,
		text: "The config file could not be read or evaluated.",
	},
	config_not_found: { exitCode: EXIT_FAILURE, text: "No config file exists in the project." },
	config_removed_key: {
		exitCode: EXIT_FAILURE,
		text: "The config file uses a key that was removed.",
	},
	declined: { exitCode: EXIT_FAILURE, text: "The user answered no to a confirmation." },
	detach_unsupported: {
		exitCode: EXIT_FAILURE,
		text: "The host does not let a session outlive the terminal.",
	},
	hook_depth_exceeded: {
		exitCode: EXIT_FAILURE,
		text: "Hooks that call forge nested deeper than the limit.",
	},
	hook_failed: { exitCode: EXIT_FAILURE, text: "A hook failed or timed out." },
	identity_mismatch: {
		exitCode: EXIT_IDENTITY_UNVERIFIED,
		text: "A process does not match its identity record, so it was not killed.",
	},
	internal_error: { exitCode: EXIT_FAILURE, text: "An unexpected error; a bug in forge." },
	interrupted: { exitCode: EXIT_INTERRUPTED, text: "Stopped by a signal." },
	needs_confirmation: {
		exitCode: EXIT_NEEDS_CONFIRMATION,
		text: "A question has no safe default and the run cannot prompt.",
	},
	not_running: { exitCode: EXIT_NOT_RUNNING, text: "No session is running." },
	port_in_use: { exitCode: EXIT_FAILURE, text: "The fixed Rojo port is busy." },
	previous_generation_alive: {
		exitCode: EXIT_CLEANUP_PENDING,
		text: "Workers of an old session are still alive after the wait bound.",
	},
	process_failed: { exitCode: EXIT_FAILURE, text: "A tool that forge ran failed." },
	reaper_unavailable: {
		exitCode: EXIT_FAILURE,
		text: "The native reaper is missing or the OS is not supported.",
	},
	rojo_missing: { exitCode: EXIT_FAILURE, text: "Rojo is not installed." },
	service_failed: {
		exitCode: EXIT_FAILURE,
		text: "A session service exited, so the session stopped.",
	},
	session_replaced: {
		exitCode: EXIT_NOT_RUNNING,
		text: "The target session is gone and a new session runs in its place.",
	},
	session_running: {
		exitCode: EXIT_FAILURE,
		text: "A session already runs for this project.",
	},
	supervisor_unresponsive: {
		exitCode: EXIT_CLEANUP_PENDING,
		text: "The session supervisor did not exit within the wait bound.",
	},
	syncback_unsupported: {
		exitCode: EXIT_FAILURE,
		text: "The Rojo command has no syncback support.",
	},
	usage: { exitCode: EXIT_USAGE, text: "The command line could not be read." },
};

/** Options that {@link ForgeError} takes beyond its code and message. */
export interface ForgeErrorOptions {
	cause?: unknown;
	/**
	 * Machine-readable facts about the failure, such as hook results. The
	 * `--json` result carries them as `error.details`.
	 */
	details?: Readonly<Record<string, unknown>>;
	/** One line that tells the user what to do next. */
	hint?: string;
}

/**
 * An expected failure: bad input or an external failure that forge reports
 * with a stable code. Invariants use `assert` instead.
 */
export class ForgeError extends Error {
	public readonly code: ForgeErrorCode;
	public readonly details: Readonly<Record<string, unknown>> | undefined;
	public readonly hint: string | undefined;
	public override readonly name = "ForgeError";

	constructor(code: ForgeErrorCode, message: string, options: ForgeErrorOptions = {}) {
		super(message, { cause: options.cause });
		this.code = code;
		this.details = options.details;
		this.hint = options.hint;
	}

	/**
	 * The exit code the process ends with for this error.
	 *
	 * @returns The code from {@link ERROR_CODES}.
	 */
	public get exitCode(): ExitCode {
		return ERROR_CODES[this.code].exitCode;
	}
}
