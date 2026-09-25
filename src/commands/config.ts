import { loadProjectConfigAsync } from "../config/load.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { CommandContext, CommandInput } from "./context.ts";

/**
 * `forge config`: load the project's config and print it resolved (flags over
 * the file over the defaults).
 *
 * @param context - The run: project directory and config loader.
 * @param input - The config values flags set.
 * @returns The resolved config and the file's path.
 */
export async function runConfigAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const { config, path } = await loadProjectConfigAsync(
		context.cwd,
		context.seams.configLoader,
		input.config,
	);

	return {
		data: { config, path },
		summary: `${path}\n${JSON.stringify(config, undefined, "\t")}`,
	};
}
