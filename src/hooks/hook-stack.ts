import type { HookCommand } from "../config/schema.ts";
import { readVariable } from "../process/environment.ts";
import type { Environment } from "../seams/seams.ts";

/**
 * The variable that carries the hook-identity stack into every hook. A forge
 * run inside a hook inherits it, so it knows which hooks are already running
 * above it.
 */
export const HOOK_STACK_VARIABLE = "RBX_FORGE_HOOK_STACK";

/** The deepest hooks may nest (a hook that runs forge that runs a hook...). */
export const MAX_HOOK_DEPTH = 8;

/** When a hook runs: before its command, or after the command succeeds. */
export type HookPhase = "post" | "pre";

const SEPARATOR = ",";

/**
 * The identity of one hook: its command, phase, and index in the list.
 *
 * @param command - The forge command the hook belongs to.
 * @param phase - `pre` or `post`.
 * @param index - Position in the phase's list, from 0.
 * @returns An id such as `build:post:0`.
 */
export function hookId(command: HookCommand, phase: HookPhase, index: number): string {
	return `${command}:${phase}:${index}`;
}

/**
 * The hooks already running above this forge run, outermost first.
 *
 * @param environment - The variables forge started with.
 * @param platform - The OS, for variable name case.
 * @returns The inherited stack; empty outside any hook.
 */
export function readHookStack(environment: Environment, platform: NodeJS.Platform): Array<string> {
	return (readVariable(environment, HOOK_STACK_VARIABLE, platform) ?? "")
		.split(SEPARATOR)
		.filter((id) => id !== "");
}

/**
 * The stack value a hook's process inherits.
 *
 * @param stack - Hook ids, outermost first, ending with the hook itself.
 * @returns The variable's value.
 */
export function formatHookStack(stack: ReadonlyArray<string>): string {
	return stack.join(SEPARATOR);
}
