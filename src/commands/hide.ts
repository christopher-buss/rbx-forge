import type { CommandResult } from "../seams/reporter.ts";
import type { CommandContext, CommandInput } from "./context.ts";
import { runStudioMoveAsync } from "./studio-move.ts";

/**
 * Save and reopen the session Studio on the hidden desktop.
 * @param context - The project and seams.
 * @param input - The save timeout and Studio path flags.
 * @returns The desktops, replacement PID, save, and elapsed time.
 * @rejects The session, save, close, or launch error.
 */
export async function runHideAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	return runStudioMoveAsync(context, input, "hidden");
}
