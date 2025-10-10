import { log, spinner } from "@clack/prompts";

import { execa, type Options as ExecaOptions, type ResultPromise } from "execa";
import type { Except } from "type-fest";

export interface RunOptions extends ExecaOptions {
	/** Custom spinner instance to use instead of creating a new one. */
	customSpinner?: Spinner;
	/**
	 * Whether to show the command being executed.
	 *
	 * @default true
	 */
	shouldShowCommand?: boolean;
	/**
	 * Whether to stream stdout/stderr to console.
	 *
	 * @default true
	 */
	shouldStreamOutput?: boolean;
	/** Show a spinner with this message while the command runs. */
	spinnerMessage?: string;
	/** Message to show on success (uses spinner.stop if spinner is shown). */
	successMessage?: string;
}

type Spinner = ReturnType<typeof spinner>;

/**
 * Creates and starts a spinner with the given message.
 *
 * @template T - The type of the message, either string or undefined.
 * @param message - The message to display with the spinner. If undefined, no
 *   spinner is created.
 * @returns A started Spinner instance if a message is provided, otherwise
 *   undefined.
 */
export function createSpinner<T extends string | undefined>(
	message: T,
): T extends string ? Spinner : undefined;
export function createSpinner(message: string | undefined): Spinner | undefined {
	if (message === undefined) {
		return undefined;
	}

	const activeSpinner = spinner();
	activeSpinner.start(message);
	return activeSpinner;
}

/**
 * Execute a shell command with pretty output using execa and @clack/prompts.
 *
 * @example
 *
 * ```ts
 * // Simple usage
 * await run("rojo", ["build"]);
 *
 * // With spinner
 * await run("rojo", ["build"], {
 * 	spinnerMessage: "Building project...",
 * 	successMessage: "Build complete!",
 * });
 *
 * // Get output
 * const { stdout } = await run("rojo", ["--version"]);
 * console.log(stdout);
 * ```
 *
 * @param command - The command to execute (e.g., "rojo", "npm").
 * @param args - Array of arguments to pass to the command.
 * @param options - Configuration options for execution and display.
 * @returns Promise resolving to the execa result.
 */
export async function run(
	command: string,
	args: ReadonlyArray<string> = [],
	options: RunOptions = {},
): Promise<Awaited<ResultPromise>> {
	const {
		customSpinner,
		shouldShowCommand = true,
		shouldStreamOutput = true,
		spinnerMessage,
		successMessage,
		...execaOptions
	} = options;

	if (shouldShowCommand) {
		log.step(`${command} ${args.join(" ")}`);
	}

	const activeSpinner = customSpinner ?? createSpinner(spinnerMessage);
	const subprocess = execa(command, args, {
		...execaOptions,
		stderr: shouldStreamOutput ? "inherit" : (execaOptions.stderr ?? "pipe"),
		stdout: shouldStreamOutput ? "inherit" : (execaOptions.stdout ?? "pipe"),
	});

	return handleSubprocess(subprocess, activeSpinner, successMessage);
}

/**
 * Execute a command and return only stdout as a string Useful for getting
 * command output without streaming.
 *
 * @example
 *
 * ```ts
 * const version = await runOutput("rojo", ["--version"]);
 * console.log(version); // "7.4.1"
 * ```
 *
 * @param command - The command to execute (e.g., "rojo", "npm").
 * @param args - Array of arguments to pass to the command.
 * @param options - Configuration options (shouldStreamOutput is disabled by
 *   default).
 * @returns Promise resolving to the trimmed stdout string.
 */
export async function runOutput(
	command: string,
	args: ReadonlyArray<string> = [],
	options: Except<RunOptions, "shouldStreamOutput"> = {},
): Promise<string> {
	const result = await run(command, args, {
		...options,
		shouldShowCommand: false,
		shouldStreamOutput: false,
	});

	const stdout = String(result.stdout);
	return stdout.trim();
}

async function handleSubprocess<OptionsType extends ExecaOptions>(
	subprocess: ResultPromise<OptionsType>,
	activeSpinner: Spinner | undefined,
	successMessage: string | undefined,
): Promise<Awaited<ResultPromise>> {
	try {
		const result = await subprocess;
		if (activeSpinner !== undefined && successMessage !== undefined) {
			activeSpinner.stop(successMessage);
		}

		return result as unknown as Awaited<ResultPromise>;
	} catch (err) {
		activeSpinner?.stop("Command failed");
		throw err;
	}
}
