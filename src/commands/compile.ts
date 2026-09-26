import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

import type { KnownSession } from "../client/session.ts";
import { fetchStatusAsync, findSession } from "../client/session.ts";
import type { CompileReport, Diagnostic } from "../compiler/diagnostics.ts";
import { createCompilerOutputParser } from "../compiler/sloptor.ts";
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
import { FRESH_BUILD_TIMEOUT_MS } from "../session/build-watch.ts";
import { COMPILER_MISSING_HINT } from "../session/plan.ts";
import type { SessionStatus } from "../session/status.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
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

		const parser = createCompilerOutputParser();
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
 * shows only a bounded tail of it. While a session runs, its watch-mode
 * compiler owns the output: this waits for its fresh build instead.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param input - The parsed flags.
 * @returns The diagnostics, error count, log path, and hook results; with a
 *   session, also its `sessionId`.
 * @rejects {ForgeError} `command_unavailable` for a Luau project,
 *   `compile_failed` when the compiler reports errors, `compiler_off` when
 *   a session runs with no compiler, a config error, or a failure from the
 *   compiler, the session's wait, or a hook.
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

	const session = await runningSessionAsync(context);
	if (session !== undefined) {
		return sessionBuildAsync(context, config, session);
	}

	const { hooks, value } = await compileAsync(context, config);

	return {
		data: { ...value, hooks },
		summary: `Compiled: ${counts(value)}. Full output: ${value.log}`,
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

function counts({ diagnostics, errors }: CompileReport): string {
	const warnings = diagnostics.filter(({ severity }) => severity === "warning").length;
	return `${plural(errors, "error")}, ${plural(warnings, "warning")}`;
}

/**
 * The project's session, if one answers, with its compiler running.
 *
 * @param context - The project root and seams.
 * @returns The session, or `undefined` when none answers.
 * @rejects {ForgeError} `compiler_off` when its compiler does not run; a
 *   status failure other than `not_running`.
 */
async function runningSessionAsync(context: CommandContext): Promise<KnownSession | undefined> {
	const { fileSystem, ipc } = context.seams;
	const session = findSession(fileSystem, forgeFiles(context.cwd));
	if (session === undefined) {
		return undefined;
	}

	let status: SessionStatus;
	try {
		status = await fetchStatusAsync(ipc, session);
	} catch (err) {
		if (err instanceof ForgeError && err.code === "not_running") {
			return undefined;
		}

		throw err;
	}

	const { sessionId } = session.files;
	const { status: compiler } = status.services.compiler;
	if (compiler !== "ready" && compiler !== "starting") {
		throw new ForgeError(
			"compiler_off",
			`Session ${sessionId} runs, but its compiler is ${compiler}: no build to report.`,
			{
				details: { sessionId, status: compiler },
				hint: 'Run "forge up" to start the compiler, then forge compile again.',
			},
		);
	}

	return session;
}

function describeDiagnostic({ code, column, file, line, message, severity }: Diagnostic): string {
	const where = file === null ? "" : `${file}:${line}:${column} - `;
	return `  ${where}${severity} ${code}: ${message.split("\n", 1)[0]}`;
}

function sessionCompileError(
	sessionId: string,
	details: Pick<CompileOutcome, "diagnostics" | "errors" | "log">,
): ForgeError {
	const errors = details.diagnostics.filter(({ severity }) => severity === "error");
	const shown = errors.slice(0, MESSAGE_TAIL_LINES).map(describeDiagnostic);
	const more = errors.length - shown.length;
	const lines = [
		`The build of session ${sessionId} has ${plural(details.errors, "error")}:`,
		...shown,
		...(more > 0 ? [`  ...and ${more} more`] : []),
		`Full output: ${details.log}`,
	];

	return new ForgeError("compile_failed", lines.join("\n"), {
		details: { ...details, sessionId },
		hint: "Fix the errors, then run forge compile again.",
	});
}

/**
 * `forge compile` in a running session: wait for the session's fresh build,
 * with the `compile` hooks around the wait, and report it as a compile.
 *
 * @param context - The run.
 * @param config - The hooks.
 * @param session - The session with its compiler running.
 * @returns The build's diagnostics, error count, log path, and hook results.
 * @rejects {ForgeError} `compile_failed` when the build has errors; the
 *   wait's failure, such as `compile_timeout` or `service_failed`.
 */
async function sessionBuildAsync(
	context: CommandContext,
	config: ResolvedConfig,
	session: KnownSession,
): Promise<CommandResult> {
	const { sessionId } = session.files;
	const log = logFilePath(context.cwd, "compiler");
	const { hooks, value } = await runWithHooksAsync(context, config, "compile", async () => {
		const status = await fetchStatusAsync(context.seams.ipc, session, FRESH_BUILD_TIMEOUT_MS);
		const build = status.services.compiler.lastBuild;
		assert(build !== undefined);
		const { diagnostics, errors } = build;
		if (errors > 0) {
			throw sessionCompileError(sessionId, { diagnostics, errors, log });
		}

		const durationMs = Date.parse(build.at) - Date.parse(build.startedAt);
		return { diagnostics, durationMs, errors, log };
	});

	return {
		data: { ...value, hooks, sessionId },
		summary: `Session ${sessionId} built: ${counts(value)}. Full output: ${log}`,
	};
}
