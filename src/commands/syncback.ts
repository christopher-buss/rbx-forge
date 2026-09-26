import type { FlagDefinition } from "../cli/flags.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import type { CommandResult } from "../seams/reporter.ts";
import { resolveSyncbackTarget, syncbackAsync } from "../syncback/syncback.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const SYNCBACK_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "input",
		config: "syncback.inputPath",
		kind: "string",
		text: "The place file to read.",
		value: "<path>",
	},
	{
		name: "project",
		config: "syncback.projectPath",
		kind: "string",
		text: "The Rojo project to write.",
		value: "<path>",
	},
];

/**
 * `forge syncback`: run one syncback from the place file into the project,
 * with its hooks.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param input - The parsed flags.
 * @returns What was synced and the hook results.
 * @rejects A config error, or a syncback failure from
 *   `syncback/syncback.ts`.
 */
export async function runSyncbackCommandAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const { config } = await loadProjectConfigAsync(
		context.cwd,
		context.seams.configLoader,
		input.config,
	);
	const { hooks, value } = await syncbackAsync(context, config, resolveSyncbackTarget(config));

	return {
		data: { ...value, hooks },
		summary: `Synced ${value.input} into ${value.project}.`,
	};
}
