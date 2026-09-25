import { stripVTControlCharacters } from "node:util";

import type { CompileReport } from "../compiler/diagnostics.ts";
import { createDiagnosticsParser } from "../compiler/diagnostics.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import type { HookedRun } from "../hooks/run-hooks.ts";
import { runWithHooksAsync } from "../hooks/run-hooks.ts";
import { logFilePath, openLogFile } from "../output/log-file.ts";
import type { ProcessOutcome } from "../process/process-runner.ts";
import type { ToolCall } from "../process/run-tool.ts";
import { checkToolOutcome, spawnToolAsync } from "../process/run-tool.ts";
import type { CommandResult } from "../seams/reporter.ts";
import { COMPILER_MISSING_HINT } from "../session/plan.ts";
import type { CommandContext, CommandInput } from "./context.ts";

/** What one successful compile produced. */
export interface CompileOutcome extends CompileReport {
	durationMs: number;
	/** The log file with the compiler's full output. */
	log: string;
}

/** Output lines a failure message shows; the log has the rest. */
const MESSAGE_TAIL_LINES = 20;

/**
 * The compile step with its `compile` hooks. `forge compile` runs it, and
 * so does `forge start` before its services. The compiler's output goes line
 * by line to the compile log and the diagnostics parser.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param config - The compiler command, its arguments, and the hooks.
 * @returns The compile outcome and every hook result.
 * @rejects {ForgeError} `compile_failed`, `compiler_missing`,
 *   `process_failed`, `hook_failed`, or `hook_depth_exceeded`.
 */
export async function compileAsync(
	context: CommandContext,
	config: ResolvedConfig,
): Promise<HookedRun<CompileOutcome>> {
	return runWithHooksAsync(context, config, "compile", async () => {
		const { clock, fileSystem } = context.seams;
		const log = openLogFile(fileSystem, logFilePath(context.cwd, "compile"));
		const startedAt = new Date(clock.now());
		log.write(`--- forge compile ${startedAt.toISOString()} ---`);

		const parser = createDiagnosticsParser();
		const call: ToolCall = {
			args: config.rbxts.args,
			command: config.rbxts.command,
			label: "The compiler",
			missing: "compiler_missing",
			missingHint: COMPILER_MISSING_HINT,
			onLine: (line) => {
				log.write(stripVTControlCharacters(line));
				parser.read(line);
			},
			step: config.rbxts.command,
		};
		const outcome = await spawnToolAsync(context, call);
		const report = { ...parser.finish(), log: log.file };
		if (outcome.type === "exited" && outcome.exitCode !== null && outcome.exitCode !== 0) {
			throw compileError(call, outcome, report);
		}

		return { ...report, durationMs: checkToolOutcome(call, outcome).durationMs };
	});
}

/**
 * `forge compile`: compile a roblox-ts project once. The compiler's output is
 * read into diagnostics and written in full to the compile log; the view
 * shows only a bounded tail of it.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param input - The parsed flags.
 * @returns The diagnostics, error count, log path, and hook results.
 * @rejects {ForgeError} `command_unavailable` for a Luau project,
 *   `compile_failed` when the compiler reports errors, a config error, or a
 *   failure from the compiler or a hook.
 */
export async function runCompileCommandAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const { config } = await loadProjectConfigAsync(
		context.cwd,
		context.seams.configLoader,
		input.config,
	);
	if (config.projectType !== "rbxts") {
		throw new ForgeError(
			"command_unavailable",
			`forge compile is for roblox-ts projects; this project has projectType "${config.projectType}".`,
			{
				hint: "Luau projects have no compile step: run your Luau tools, such as darklua, directly.",
			},
		);
	}

	const { hooks, value } = await compileAsync(context, config);
	const warnings = value.diagnostics.length - value.errors;

	return {
		data: { ...value, hooks },
		summary: `Compiled: ${plural(value.errors, "error")}, ${plural(warnings, "warning")}. Full output: ${value.log}`,
	};
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function compileError(
	call: ToolCall,
	outcome: Extract<ProcessOutcome, { type: "exited" }>,
	details: Pick<CompileOutcome, "diagnostics" | "errors" | "log">,
): ForgeError {
	const tail = outcome.outputTail
		.slice(-MESSAGE_TAIL_LINES)
		.map((line) => `  ${stripVTControlCharacters(line)}`);
	const header = `${call.step} failed with ${plural(details.errors, "error")} (exit code ${String(outcome.exitCode)}):`;

	return new ForgeError(
		"compile_failed",
		[header, ...tail, `Full output: ${details.log}`].join("\n"),
		{
			details: { ...details, outputTail: outcome.outputTail },
			hint: "Fix the errors, then run forge compile again.",
		},
	);
}
