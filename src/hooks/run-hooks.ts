import path from "node:path";

import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import type { HookCommand } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import { shellInvocation } from "../process/command-line.ts";
import { prependPath, withVariables } from "../process/environment.ts";
import type { ProcessOutcome } from "../process/process-runner.ts";
import type { HookPhase } from "./hook-stack.ts";
import {
	formatHookStack,
	HOOK_STACK_VARIABLE,
	hookId,
	MAX_HOOK_DEPTH,
	readHookStack,
} from "./hook-stack.ts";

/** How one hook ended. */
export interface HookResult {
	/** Such as `build:post:0`. */
	id: string;
	/** The shell command line from the config. */
	command: string;
	durationMs: number;
	/** `null` when the hook did not exit on its own. */
	exitCode: null | number;
	/** The hook succeeded, or was skipped as a cycle. */
	ok: boolean;
	/**
	 * `skipped`: the hook is already running above this forge run, so running
	 * it again would loop.
	 */
	outcome: "failed" | "skipped" | "succeeded" | "timed_out";
	/** The last lines of stdout and stderr together. */
	outputTail: Array<string>;
}

/**
 * What {@link runWithHooksAsync} returns.
 *
 * @template T - What the command's own step returns.
 */
export interface HookedRun<T> {
	/** Every hook that ran or was skipped, in order. */
	hooks: Array<HookResult>;
	value: T;
}

/** The config {@link runWithHooksAsync} reads. */
export type HookConfig = Pick<ResolvedConfig, "hooks" | "hookTimeoutMs">;

/** Output lines a failure message repeats; the details carry the full tail. */
const MESSAGE_TAIL_LINES = 10;

/** One {@link runWithHooksAsync} call: what every hook of it shares. */
interface HookRun {
	config: HookConfig;
	context: CommandContext;
	/** Results so far, in run order. */
	results: Array<HookResult>;
	/** The hook ids running above this forge run, outermost first. */
	stack: ReadonlyArray<string>;
}

/** The part of a {@link HookResult} its process decides. */
type ProcessPart = Pick<HookResult, "durationMs" | "exitCode" | "ok" | "outcome" | "outputTail">;

/**
 * Run a command's step between its config hooks: every `pre` hook in order,
 * then the step, then every `post` hook in order. Each chained step calls
 * this for its own command, so hooks apply however a step is reached.
 *
 * - A `pre` hook that fails aborts: no further hook runs, and neither does
 *   the step.
 * - `post` hooks run only when the step succeeds.
 * - A hook that outlives `hookTimeoutMs` is killed with its process tree.
 * - A hook already on the inherited hook stack is skipped (a forge run inside
 *   that hook reached it again); nesting deeper than {@link MAX_HOOK_DEPTH}
 *   fails.
 *
 * Hooks run in the project root through the system shell, with the project's
 * `node_modules/.bin` first on `PATH`.
 *
 * @template T - What the step returns.
 * @param context - The run: project root, environment, seams, reporter.
 * @param config - The hooks and their timeout.
 * @param command - The command whose hooks run.
 * @param step - The command's own work.
 * @returns The step's value and every hook result.
 * @rejects {ForgeError} `hook_failed` or `hook_depth_exceeded` from a hook;
 *   anything the step rejects with. Details carry the hook results so far.
 */
export async function runWithHooksAsync<T>(
	context: CommandContext,
	config: HookConfig,
	command: HookCommand,
	step: () => Promise<T>,
): Promise<HookedRun<T>> {
	const run: HookRun = {
		config,
		context,
		results: [],
		stack: readHookStack(context.env, context.seams.host.platform),
	};

	await runPhaseAsync(run, command, "pre");
	const value = await step();
	await runPhaseAsync(run, command, "post");

	return { hooks: run.results, value };
}

function skip({ context }: HookRun, id: string, command: string): HookResult {
	context.reporter.emit({
		message: `Skipped hook ${id} (${command}): it is already running above this forge run.`,
		type: "warning",
	});
	return {
		id,
		command,
		durationMs: 0,
		exitCode: null,
		ok: true,
		outcome: "skipped",
		outputTail: [],
	};
}

function outcomeOf(outcome: ProcessOutcome): HookResult["outcome"] {
	if (outcome.type === "exited" && outcome.exitCode === 0) {
		return "succeeded";
	}

	return outcome.type === "timed_out" ? "timed_out" : "failed";
}

function resultOf(outcome: ProcessOutcome): ProcessPart {
	const result = outcomeOf(outcome);
	const shared = { ok: result === "succeeded", outcome: result };
	if (outcome.type === "spawn_failed") {
		return { ...shared, durationMs: 0, exitCode: null, outputTail: [outcome.message] };
	}

	return {
		...shared,
		durationMs: outcome.durationMs,
		exitCode: outcome.type === "exited" ? outcome.exitCode : null,
		outputTail: outcome.outputTail,
	};
}

/**
 * Start a hook's process and wait for it. The hook inherits the stack with
 * its own id added.
 *
 * @param run - The hooks' shared state.
 * @param id - The hook's identity.
 * @param command - Its shell command line.
 * @returns How it ended.
 */
async function spawnHookAsync(
	{ config, context, stack }: HookRun,
	id: string,
	command: string,
): Promise<HookResult> {
	const { cwd, env, reporter, seams } = context;
	const { platform } = seams.host;
	const environment = withVariables(
		prependPath(env, path.join(cwd, "node_modules", ".bin"), platform),
		{ [HOOK_STACK_VARIABLE]: formatHookStack([...stack, id]) },
		platform,
	);
	const name = `hook ${id}: ${command}`;

	reporter.emit({ name, status: "started", type: "step" });
	const outcome = await seams.processRunner({
		...shellInvocation(command, platform, environment),
		cwd,
		env: environment,
		timeoutMs: config.hookTimeoutMs,
	});
	const result = { id, command, ...resultOf(outcome) };
	reporter.emit({ name, status: result.ok ? "succeeded" : "failed", type: "step" });

	return result;
}

function failureMessage(result: HookResult, timeoutMs: number): string {
	const reason =
		result.outcome === "timed_out"
			? `timed out after ${timeoutMs} ms and was killed`
			: `failed (exit code ${String(result.exitCode)})`;
	const tail = result.outputTail.slice(-MESSAGE_TAIL_LINES).map((line) => `  ${line}`);
	return [`Hook ${result.id} ${reason}: ${result.command}`, ...tail].join("\n");
}

/**
 * Run one hook, or skip it when it is already running above this run.
 *
 * @param run - The hooks' shared state.
 * @param id - The hook's identity.
 * @param command - Its shell command line.
 * @returns Its result when it succeeded or was skipped.
 * @rejects {ForgeError} `hook_depth_exceeded` or `hook_failed`.
 */
async function runHookAsync(run: HookRun, id: string, command: string): Promise<HookResult> {
	if (run.stack.includes(id)) {
		return skip(run, id, command);
	}

	const nested = [...run.stack, id];
	if (nested.length > MAX_HOOK_DEPTH) {
		throw new ForgeError(
			"hook_depth_exceeded",
			`Hook ${id} would nest ${nested.length} hooks deep; the limit is ${MAX_HOOK_DEPTH}.`,
			{
				details: { hooks: run.results, stack: nested },
				hint: "A hook runs forge, which runs hooks that run forge again. Break the chain in the config.",
			},
		);
	}

	const result = await spawnHookAsync(run, id, command);
	if (!result.ok) {
		throw new ForgeError("hook_failed", failureMessage(result, run.config.hookTimeoutMs), {
			details: { hooks: [...run.results, result] },
			hint: "Fix the hook, or remove it from hooks in the config.",
		});
	}

	return result;
}

async function runPhaseAsync(run: HookRun, command: HookCommand, phase: HookPhase): Promise<void> {
	const lines = run.config.hooks[command]?.[phase] ?? [];
	for (const [index, line] of lines.entries()) {
		run.results.push(await runHookAsync(run, hookId(command, phase, index), line));
	}
}
