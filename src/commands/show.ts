import type { CommandResult } from "../seams/reporter.ts";
import type { CommandContext, CommandInput } from "./context.ts";
import { runStudioMoveAsync } from "./studio-move.ts";

/**
 * Save and show the session Studio.
 * @param context - The project and seams.
 * @param input - The save timeout and Studio path flags.
 * @returns The visibility transition, PID, save, and elapsed time.
 * @rejects The session, save, close, or launch error.
 */
export async function runShowAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	return runStudioMoveAsync(context, input, "user");
}
