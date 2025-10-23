import { log, spinner, taskLog } from "@clack/prompts";

import ansis from "ansis";
import { execa, type Options as ExecaOptions, type ResultPromise } from "execa";
import process from "node:process";
import { createInterface } from "node:readline";
import {
	type Command,
	getUserAgent,
	resolveCommand,
	type ResolvedCommand,
} from "package-manager-detector";
import type { ScriptName } from "src/commands";
import { loadProjectConfig } from "src/config";
import { CLI_COMMAND } from "src/constants";
import type { Except } from "type-fest";

import { getCommandName } from "./command-names";
import { getCallingTaskRunner } from "./detect-task-runner";

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

export interface RunWithTaskLogOptions extends Except<ExecaOptions, "all" | "buffer"> {
	/** Maximum number of messages to display (default: 12). */
	messageLimit?: number;
	/** Display name for the task logger. */
	taskName: string;
}

export interface TaskLogResult {
	/** Subprocess promise. */
	subprocess: ResultPromise;
	/** Task logger instance for success/error messages. */
	taskLogger: ReturnType<typeof taskLog>;
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

export async function findCommandForPackageManager(
	command: Command,
	args: Array<string> = [],
): Promise<ResolvedCommand> {
	const agent = getUserAgent();
	if (!agent) {
		throw new Error("Could not detect current package manager.");
	}

	const result = resolveCommand(agent, command, args);
	if (!result) {
		throw new Error(`Could not resolve ${command} command for package manager: ${agent}`);
	}

	return result;
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

/**
 * Runs a script via the appropriate task runner.
 *
 * This function enables command chaining while respecting the calling context.
 * If the current process was invoked via npm/mise, subsequent commands will use
 * the same task runner. This ensures consistency and allows users to hook into
 * commands by customizing scripts in package.json or .mise.toml.
 *
 * Priority order:
 *
 * 1. Use the task runner that invoked the current process (context-aware)
 * 2. Auto-detect available task runners (mise > npm)
 * 3. Fallback to direct CLI invocation.
 *
 * @example Implementing a start command that chains build → serve
 *
 * ```typescript
 * // src/commands/start.ts
 * import { loadProjectConfig } from "../config";
 * import { runScript } from "../utils/run-script";
 *
 * export async function action(): Promise<void> {
 * 	const config = await loadProjectConfig();
 *
 * 	// Build the project first
 * 	await runScript("build", config);
 *
 * 	// Then start the dev server
 * 	await runScript("serve", config);
 * }
 *
 * // If user customized their scripts:
 * // package.json: "forge:build": "npm run typecheck && rbx-forge build"
 * // The typecheck will run before building, respecting user hooks!
 * ```
 *
 * @param scriptName - The base script name to run (e.g., "build", "serve").
 * @param args - Additional arguments to pass to the script.
 */
export async function runScript(
	scriptName: ScriptName,
	args: ReadonlyArray<string> = [],
): Promise<void> {
	const config = await loadProjectConfig();
	const resolvedName = getCommandName(scriptName, config);
	const callingRunner = getCallingTaskRunner();

	if (callingRunner === "mise") {
		await run("mise", ["run", resolvedName, ...args], { shouldShowCommand: false });
		return;
	}

	if (callingRunner === "npm") {
		await runWithPackageManager(resolvedName, args);
		return;
	}

	const hasShownWarning = process.env["RBX_FORGE_NO_TASK_RUNNER_WARNING_SHOWN"] === "1";
	const shouldSuppressWarning = config.suppressNoTaskRunnerWarning;
	if (!hasShownWarning && !shouldSuppressWarning) {
		log.warn(
			ansis.yellow(
				"⚠ No task runner detected - running command directly. This may skip user-defined hooks.",
			),
		);
		process.env["RBX_FORGE_NO_TASK_RUNNER_WARNING_SHOWN"] = "1";
	}

	await run(CLI_COMMAND, [scriptName, ...args], { shouldShowCommand: false });
}

/**
 * Execute a command with streaming output to a task logger.
 *
 * Useful for long-running processes like compilers and watchers that produce
 * verbose output. Unlike run(), this creates a scrolling task log that shows
 * the last N lines of output.
 *
 * @example
 *
 * ```ts
 * const { subprocess, taskLogger } = await runWithTaskLog(
 * 	"rbxtsc",
 * 	["--verbose"],
 * 	{
 * 		taskName: "Compiling TypeScript...",
 * 	},
 * );
 *
 * try {
 * 	await subprocess;
 * 	taskLogger.success("Compilation complete");
 * } catch (err) {
 * 	taskLogger.error("Compilation failed");
 * 	throw err;
 * }
 * ```
 *
 * @param command - The command to execute (e.g., "rbxtsc", "npm").
 * @param args - Array of arguments to pass to the command.
 * @param options - Configuration options including task name and message limit.
 * @returns Object containing the subprocess promise and task logger instance.
 */
export function runWithTaskLog(
	command: string,
	args: ReadonlyArray<string>,
	options: RunWithTaskLogOptions,
): TaskLogResult {
	const { messageLimit = 12, taskName, ...execaOptions } = options;

	const taskLogger = taskLog({
		limit: messageLimit,
		title: taskName,
	});

	const subprocess = execa(command, args, {
		...execaOptions,
		all: true,
		buffer: false,
	});

	const rl = createInterface({
		crlfDelay: Number.POSITIVE_INFINITY,
		input: subprocess.all,
	});

	rl.on("line", (line) => {
		taskLogger.message(line);
	});

	void subprocess.finally(() => {
		rl.close();
	});

	return {
		subprocess: subprocess as ResultPromise,
		taskLogger,
	};
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

async function runWithPackageManager(
	resolvedName: string,
	runArguments: ReadonlyArray<string>,
): Promise<void> {
	const { args, command } = await findCommandForPackageManager("run", [resolvedName]);

	await run(command, [...args, ...runArguments], {
		shouldShowCommand: false,
	});
}
