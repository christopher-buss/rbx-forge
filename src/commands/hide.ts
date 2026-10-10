import type { CommandResult } from "../seams/reporter.ts";
import type { CommandContext, CommandInput } from "./context.ts";
import { runStudioMoveAsync } from "./studio-move.ts";

/**
 * Hide the session Studio.
 * @param context - The project and seams.
 * @param input - The command flags.
 * @returns The visibility transition, unchanged PID and elapsed time.
 * @rejects The session or visibility error.
 */
export async function runHideAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	return runStudioMoveAsync(context, input, "hidden");
}
