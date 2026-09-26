import type { CommandContext } from "../commands/context.ts";
import type { ForgeErrorCode } from "../errors.ts";
import { ForgeError } from "../errors.ts";
import type { Invocation } from "./command-line.ts";
import type { ProcessOutcome } from "./process-runner.ts";
import { resolveTool, toolInvocation } from "./resolve-tool.ts";

/** A tool {@link probeToolAsync} runs quietly. */
export interface ToolProbe {
	args: ReadonlyArray<string>;
	/** The configured command, such as `rojo` or `rbxtsc`. */
	command: string;
	/** Its display name, such as `Rojo`. */
	label: string;
	/** The error code when the tool is not installed. */
	missing: Extract<ForgeErrorCode, "compiler_missing" | "rojo_missing">;
	/** What to install or configure when the tool is missing. */
	missingHint: string;
}

/** A tool forge runs to completion, such as `rojo build` or `rbxtsc`. */
export interface ToolCall extends ToolProbe {
	/** Gets every output line, for a log or a parser. */
	onLine?: (line: string) => void;
	/** The step name the reporter shows, such as `rojo build`. */
	step: string;
}

/** A tool run that exited with code 0. */
export interface ToolSuccess {
	durationMs: number;
	outputTail: Array<string>;
}

/** Output lines a failure message repeats. */
const MESSAGE_TAIL_LINES = 20;

/**
 * Resolve a tool (`process/resolve-tool.ts`) to what starts it, for a run
 * that is not a step's, such as a session worker.
 *
 * @param context - The project root, environment, and seams.
 * @param call - The tool and its arguments.
 * @returns The executable and arguments to spawn.
 * @throws {ForgeError} `call.missing` when the tool is not installed.
 */
export function resolveInvocation(
	{ cwd, env, seams }: Pick<CommandContext, "cwd" | "env" | "seams">,
	call: ToolProbe,
): Invocation {
	const lookup = { cwd, env, fileSystem: seams.fileSystem, host: seams.host };
	const tool = resolveTool(call.command, lookup);
	if (tool === undefined) {
		throw missingError(call);
	}

	return toolInvocation(tool, call.args, lookup);
}

/**
 * Like {@link runToolAsync}, but return how the tool ended, for a caller that
 * reads a failure itself. Pass the outcome to {@link checkToolOutcome} for the
 * usual errors.
 *
 * @param context - The run: project root, environment, seams, reporter.
 * @param call - The tool and its arguments.
 * @returns How the tool ended.
 * @rejects {ForgeError} `call.missing` when the tool is not installed.
 */
export async function spawnToolAsync(
	context: CommandContext,
	call: ToolCall,
): Promise<ProcessOutcome> {
	const { reporter } = context;
	const spawn = prepareSpawn(context, call);
	reporter.emit({ name: call.step, status: "started", type: "step" });
	const outcome = await spawn();
	const isOk = outcome.type === "exited" && outcome.exitCode === 0;
	reporter.emit({ name: call.step, status: isOk ? "succeeded" : "failed", type: "step" });

	return outcome;
}

/**
 * Turn how a tool ended into its success, or the error for its failure.
 *
 * @param call - The tool that ran.
 * @param outcome - How it ended.
 * @returns Its duration and output tail when it exited with code 0.
 * @throws {ForgeError} `call.missing` when it could not start because it is
 *   gone, else `process_failed`.
 */
export function checkToolOutcome(call: ToolCall, outcome: ProcessOutcome): ToolSuccess {
	checkSpawned(call, outcome);
	if (outcome.type === "exited" && outcome.exitCode === 0) {
		return { durationMs: outcome.durationMs, outputTail: outcome.outputTail };
	}

	const reason =
		outcome.type === "exited"
			? `exit code ${String(outcome.exitCode)}`
			: "timed out and was killed";
	const tail = outcome.outputTail.slice(-MESSAGE_TAIL_LINES).map((line) => `  ${line}`);
	throw new ForgeError(
		"process_failed",
		[`${call.step} failed (${reason}).`, ...tail].join("\n"),
		{ details: { outputTail: outcome.outputTail } },
	);
}

/**
 * Resolve a tool (`process/resolve-tool.ts`), run it in the project root, and
 * wait for it. Reports the run as a step.
 *
 * @param context - The run: project root, environment, seams, reporter.
 * @param call - The tool and its arguments.
 * @returns Its duration and output tail when it exits with code 0.
 * @rejects {ForgeError} `call.missing` when the tool is not installed, or
 *   `process_failed` when it fails.
 */
export async function runToolAsync(context: CommandContext, call: ToolCall): Promise<ToolSuccess> {
	return checkToolOutcome(call, await spawnToolAsync(context, call));
}

/**
 * Run a tool quietly to learn what it supports, such as `rojo syncback
 * --help`. A check, not a step: the reporter sees nothing.
 *
 * @param context - The run: project root, environment, seams.
 * @param call - The tool and its arguments.
 * @returns Whether it exited with code 0.
 * @rejects {ForgeError} `call.missing` when the tool is not installed, or
 *   `process_failed` when it cannot start.
 */
export async function probeToolAsync(context: CommandContext, call: ToolProbe): Promise<boolean> {
	const outcome = await prepareSpawn(context, call)();
	checkSpawned(call, outcome);
	return outcome.type === "exited" && outcome.exitCode === 0;
}

function missingError(call: ToolProbe): ForgeError {
	return new ForgeError(
		call.missing,
		`${call.label} ("${call.command}") is not installed: it is not a bin of a project dependency or on PATH.`,
		{ hint: call.missingHint },
	);
}

/**
 * Resolve the tool now, so a missing tool fails before anything is reported.
 *
 * @param context - The run: project root, environment, seams.
 * @param call - The tool and its arguments.
 * @returns Starts the tool and waits for it.
 */
function prepareSpawn(
	context: CommandContext,
	call: Pick<ToolCall, "onLine"> & ToolProbe,
): () => Promise<ProcessOutcome> {
	const { cwd, env, seams } = context;
	const invocation = resolveInvocation(context, call);
	const { onLine } = call;
	return async () => {
		return seams.processRunner({
			...invocation,
			cwd,
			env,
			...(onLine === undefined ? {} : { onLine }),
		});
	};
}

function checkSpawned(
	call: ToolProbe,
	outcome: ProcessOutcome,
): asserts outcome is Exclude<ProcessOutcome, { type: "spawn_failed" }> {
	if (outcome.type !== "spawn_failed") {
		return;
	}

	if (outcome.errorCode === "ENOENT") {
		throw missingError(call);
	}

	throw new ForgeError("process_failed", `${call.label} could not start: ${outcome.message}`);
}
