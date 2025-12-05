import process from "node:process";
import {
	type AgentName,
	type Command,
	getUserAgent,
	resolveCommand,
	type ResolvedCommand,
} from "package-manager-detector";
import type { ScriptName } from "src/commands";
import { loadProjectConfig } from "src/config";
import { CLI_COMMAND } from "src/constants";
import type { Except } from "type-fest";
import yoctoSpinner from "yocto-spinner";

import { getCommandName } from "./command-names";
import { detectAvailableTaskRunner, getCallingTaskRunner } from "./detect-task-runner";
import { logger } from "./logger";
import { processManager } from "./process-manager";

export interface RunOptions {
	/** AbortSignal to cancel the running process. */
	readonly cancelSignal?: AbortSignal;
	/** Current working directory for the command. */
	readonly cwd?: string;
	/** Environment variables to pass to the command. */
	readonly env?: Record<string, string | undefined>;
	/**
	 * Whether to register process with ProcessManager for automatic cleanup.
	 *
	 * @default false
	 */
	readonly shouldRegisterProcess?: boolean;
	/**
	 * Whether to show the command being executed.
	 *
	 * @default true
	 */
	readonly shouldShowCommand?: boolean;
	/**
	 * Whether to stream stdout/stderr to console.
	 *
	 * @default true
	 */
	readonly shouldStreamOutput?: boolean;
	/** Show a spinner with this message while the command runs. */
	readonly spinnerMessage?: string;
	/** Message to show on success (uses spinner.stop if spinner is shown). */
	readonly successMessage?: string;
}

export interface RunResult {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}

export interface StreamingRunResult {
	readonly exitCode: Promise<number>;
	readonly process: Subprocess;
}

interface RunState {
	abortHandler: (() => void) | undefined;
	spinner: ReturnType<typeof yoctoSpinner> | undefined;
	subprocess: Subprocess;
}

type Subprocess = ReturnType<typeof Bun.spawn>;

/** Error thrown when a command fails. */
export class RunError extends Error {
	public readonly args: ReadonlyArray<string>;
	public readonly command: string;
	public readonly exitCode: number;
	public readonly stderr: string;
	public readonly stdout: string;

	public override name = "RunError";

	constructor(
		command: string,
		args: ReadonlyArray<string>,
		exitCode: number,
		stdout: string,
		stderr: string,
	) {
		super(`Command failed: ${command} ${args.join(" ")}`);
		this.command = command;
		this.args = args;
		this.exitCode = exitCode;
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

export async function findCommandForPackageManager(
	command: Command,
	args: Array<string> = [],
	packageManager?: AgentName,
): Promise<ResolvedCommand> {
	const agent = packageManager ?? getUserAgent();
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
 * Execute a shell command with pretty output using Bun.spawn.
 *
 * @param command - The command to execute (e.g., "rojo", "npm").
 * @param args - Array of arguments to pass to the command.
 * @param options - Configuration options for execution and display.
 * @returns Promise resolving to the run result.
 */
export async function run(
	command: string,
	args: ReadonlyArray<string> = [],
	options: RunOptions = {},
): Promise<RunResult> {
	const { abortHandler, spinner, subprocess } = initializeRun(command, args, options);
	const exitCode = await subprocess.exited;
	const { stderr, stdout } = await getCommandOutputs(
		options.shouldStreamOutput ?? true,
		subprocess,
	);

	try {
		if (exitCode !== 0) {
			spinner?.error(options.spinnerMessage);
			throw new RunError(command, args, exitCode, stdout, stderr);
		}

		finalizeSpinner(spinner, options.successMessage);
		return { exitCode, stderr, stdout };
	} finally {
		if (abortHandler) {
			options.cancelSignal?.removeEventListener("abort", abortHandler);
		}
	}
}

/**
 * Execute a command and return only stdout as a string.
 *
 * @param command - The command to execute.
 * @param args - Array of arguments to pass to the command.
 * @param options - Configuration options.
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

	return result.stdout.trim();
}

/**
 * Runs a script via the appropriate task runner.
 *
 * @param scriptName - The base script name to run (e.g., "build", "serve").
 * @param args - Additional arguments to pass to the script.
 * @param options - Optional run options.
 */
export async function runScript(
	scriptName: ScriptName,
	args: ReadonlyArray<string> = [],
	options: RunOptions = {},
): Promise<void> {
	const config = await loadProjectConfig();
	const resolvedName = getCommandName(scriptName, config);
	const callingRunner = getCallingTaskRunner();

	const runner = callingRunner ?? (await detectAvailableTaskRunner());
	if (runner === "mise") {
		await run("mise", ["run", resolvedName, ...args], { shouldShowCommand: false, ...options });
		return;
	}

	if (runner === "npm") {
		await runWithPackageManager(resolvedName, args, options);
		return;
	}

	const hasShownWarning = Bun.env["RBX_FORGE_NO_TASK_RUNNER_WARNING_SHOWN"] === "1";
	const shouldSuppressWarning = config.suppressNoTaskRunnerWarning;
	if (!hasShownWarning && !shouldSuppressWarning) {
		logger.warn(
			"No task runner detected - running command directly. This may skip user-defined hooks.",
		);
		Bun.env["RBX_FORGE_NO_TASK_RUNNER_WARNING_SHOWN"] = "1";
	}

	await run(CLI_COMMAND, [scriptName, ...args], { shouldShowCommand: false, ...options });
}

/**
 * Execute a command with streaming output to console. Returns immediately with
 * process handle for long-running commands.
 *
 * @param command - The command to execute.
 * @param args - Array of arguments to pass to the command.
 * @param options - Configuration options.
 * @returns Object with process handle and exit code promise.
 */
export function runStreaming(
	command: string,
	args: ReadonlyArray<string> = [],
	options: Except<RunOptions, "shouldStreamOutput" | "spinnerMessage" | "successMessage"> = {},
): StreamingRunResult {
	const { cwd, env, shouldRegisterProcess = false, shouldShowCommand = true } = options;

	if (shouldShowCommand) {
		logger.step(`${command} ${args.join(" ")}`);
	}

	const subprocess = Bun.spawn([resolveBunCommand(command), ...args], {
		...(cwd !== undefined && { cwd }),
		env: getSpawnEnvironment(env),
		stderr: "inherit",
		stdout: "inherit",
	});

	if (shouldRegisterProcess) {
		processManager.register(subprocess);
	}

	return {
		exitCode: subprocess.exited,
		process: subprocess,
	};
}

function createSpinner(spinnerMessage?: string): ReturnType<typeof yoctoSpinner> | undefined {
	if (spinnerMessage === undefined || spinnerMessage.length === 0) {
		return undefined;
	}

	return yoctoSpinner({ text: spinnerMessage }).start();
}

function finalizeSpinner(
	spinner: ReturnType<typeof yoctoSpinner> | undefined,
	successMessage?: string,
): void {
	if (spinner === undefined) {
		return;
	}

	if (successMessage !== undefined && successMessage.length > 0) {
		spinner.success(successMessage);
	} else {
		spinner.stop();
	}
}

async function getCommandOutputs(
	shouldStreamOutput: boolean,
	subprocess: Subprocess,
): Promise<{ stderr: string; stdout: string }> {
	if (shouldStreamOutput) {
		return { stderr: "", stdout: "" };
	}

	const { stderr: stderrStream, stdout: stdoutStream } = subprocess;

	// When stdio is "pipe", these are ReadableStreams
	const stdout =
		stdoutStream instanceof ReadableStream ? await new Response(stdoutStream).text() : "";
	const stderr =
		stderrStream instanceof ReadableStream ? await new Response(stderrStream).text() : "";

	return { stderr, stdout };
}

/**
 * Gets spawn environment with node_modules/.bin added to PATH. This ensures
 * locally installed binaries (like rbxtsc) are found when spawning.
 *
 * @param extraEnvironment - Additional environment variables to merge.
 * @returns Environment object with enhanced PATH.
 */
function getSpawnEnvironment(
	extraEnvironment?: Record<string, string | undefined>,
): Record<string, string> {
	const isWindows = process.platform === "win32";
	const pathSeparator = isWindows ? ";" : ":";
	const binPath = `${process.cwd()}/node_modules/.bin`;
	const currentPath = Bun.env["PATH"] ?? "";

	return {
		...Bun.env,
		...extraEnvironment,
		PATH: `${binPath}${pathSeparator}${currentPath}`,
	} as Record<string, string>;
}

function initializeRun(
	command: string,
	args: ReadonlyArray<string>,
	options: RunOptions,
): RunState {
	const {
		cancelSignal,
		cwd,
		env,
		shouldRegisterProcess = false,
		shouldShowCommand = true,
		shouldStreamOutput = true,
		spinnerMessage,
	} = options;

	if (shouldShowCommand) {
		logger.step(`${command} ${args.join(" ")}`);
	}

	const spinner = createSpinner(spinnerMessage);
	const subprocess = Bun.spawn([resolveBunCommand(command), ...args], {
		...(cwd !== undefined && { cwd }),
		env: getSpawnEnvironment(env),
		stderr: shouldStreamOutput ? "inherit" : "pipe",
		stdout: shouldStreamOutput ? "inherit" : "pipe",
	});

	if (shouldRegisterProcess) {
		processManager.register(subprocess);
	}

	const abortHandler = setupAbortHandler(cancelSignal, subprocess, spinner);
	return { abortHandler, spinner, subprocess };
}

/**
 * Resolves "bun" command to actual executable path. Fixes Windows PATH issues
 * where bun isn't found when spawning subprocesses.
 *
 * @param command - The command to resolve.
 * @returns The resolved command path.
 */
function resolveBunCommand(command: string): string {
	return command === "bun" ? (Bun.argv[0] ?? "bun") : command;
}

async function runWithPackageManager(
	resolvedName: string,
	runArguments: ReadonlyArray<string>,
	options: RunOptions = {},
): Promise<void> {
	const { args, command } = await findCommandForPackageManager("run", [resolvedName]);

	await run(command, [...args, ...runArguments], {
		shouldShowCommand: false,
		...options,
	});
}

function setupAbortHandler(
	cancelSignal: AbortSignal | undefined,
	subprocess: Subprocess,
	spinner: ReturnType<typeof yoctoSpinner> | undefined,
): (() => void) | undefined {
	if (!cancelSignal) {
		return undefined;
	}

	if (cancelSignal.aborted) {
		subprocess.kill();
		spinner?.stop();
		throw new Error("Aborted");
	}

	function abortHandler(): void {
		subprocess.kill();
	}

	cancelSignal.addEventListener("abort", abortHandler);
	return abortHandler;
}
