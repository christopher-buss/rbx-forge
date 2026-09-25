import type { CommandContext } from "../commands/context.ts";
import type { ForgeErrorCode } from "../errors.ts";
import { ForgeError } from "../errors.ts";
import type { ProcessOutcome } from "./process-runner.ts";
import { resolveTool, toolInvocation } from "./resolve-tool.ts";

/** A tool forge runs to completion, such as `rojo build` or `rbxtsc`. */
export interface ToolCall {
	args: ReadonlyArray<string>;
	/** The configured command, such as `rojo` or a fork's alias. */
	command: string;
	/** Its display name, such as `Rojo`. */
	label: string;
	/** The error code when the tool is not installed. */
	missing: Extract<ForgeErrorCode, "compiler_missing" | "rojo_missing">;
	/** What to install or configure when the tool is missing. */
	missingHint: string;
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
 * Resolve a tool (`process/resolve-tool.ts`), run it in the project root, and
 * wait for it. Reports the run as a step.
 *
 * @param context - The run: project root, environment, seams, reporter.
 * @param call - The tool and its arguments.
 * @returns Its duration and output tail when it exits with code 0.
 * @rejects {ForgeError} `call.missing` when the tool is not installed, or
 *   `process_failed` when it fails.
 */
export async function runToolAsync(
	{ cwd, env, reporter, seams }: CommandContext,
	call: ToolCall,
): Promise<ToolSuccess> {
	const lookup = { cwd, env, fileSystem: seams.fileSystem, host: seams.host };
	const tool = resolveTool(call.command, lookup);
	if (tool === undefined) {
		throw missingError(call);
	}

	reporter.emit({ name: call.step, status: "started", type: "step" });
	const outcome = await seams.processRunner({
		...toolInvocation(tool, call.args, lookup),
		cwd,
		env,
	});
	const isOk = outcome.type === "exited" && outcome.exitCode === 0;
	reporter.emit({ name: call.step, status: isOk ? "succeeded" : "failed", type: "step" });

	return checkOutcome(call, outcome);
}

function missingError(call: ToolCall): ForgeError {
	return new ForgeError(
		call.missing,
		`${call.label} ("${call.command}") is not installed: it is not a bin of a project dependency or on PATH.`,
		{ hint: call.missingHint },
	);
}

function checkOutcome(call: ToolCall, outcome: ProcessOutcome): ToolSuccess {
	if (outcome.type === "spawn_failed") {
		if (outcome.errorCode === "ENOENT") {
			throw missingError(call);
		}

		throw new ForgeError("process_failed", `${call.label} could not start: ${outcome.message}`);
	}

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
