import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import type { ToolSuccess } from "../process/run-tool.ts";
import { runToolAsync } from "../process/run-tool.ts";

/** Where `rojo build` writes. */
export type BuildTarget =
	/** A place or model file, relative to the project root. */
	| { output: string; type: "output" }
	/** A file of this name in Studio's local plugins folder. */
	| { plugin: string; type: "plugin" };

/** A Rojo subcommand and its arguments. */
export type RojoArgs = readonly [subcommand: string, ...rest: Array<string>];

const MISSING_HINT =
	"Install Rojo (https://rojo.space), for example with rokit or mise, or set rojoAlias to its command.";

/**
 * The arguments of `rojo build`.
 *
 * @param project - The Rojo project file.
 * @param target - An output file or a plugin name.
 * @returns Arguments after the Rojo command.
 */
export function rojoBuildArgs(project: string, target: BuildTarget): RojoArgs {
	return target.type === "output"
		? ["build", project, "--output", target.output]
		: ["build", project, "--plugin", target.plugin];
}

/**
 * The arguments of `rojo sourcemap`, with every instance, not only scripts
 * and their ancestors.
 *
 * @param project - The Rojo project file.
 * @param output - The JSON file to write.
 * @returns Arguments after the Rojo command.
 */
export function rojoSourcemapArgs(project: string, output: string): RojoArgs {
	return ["sourcemap", project, "--output", output, "--include-non-scripts"];
}

/**
 * Run a Rojo subcommand with the configured Rojo command, as a step.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param config - Holds `rojoAlias`.
 * @param args - The subcommand and its arguments.
 * @returns The run's duration and output tail.
 * @rejects `rojo_missing`, or `process_failed` when Rojo fails.
 */
export async function runRojoAsync(
	context: CommandContext,
	config: Pick<ResolvedConfig, "rojoAlias">,
	args: RojoArgs,
): Promise<ToolSuccess> {
	return runToolAsync(context, {
		args,
		command: config.rojoAlias,
		label: "Rojo",
		missing: "rojo_missing",
		missingHint: MISSING_HINT,
		step: `rojo ${args[0]}`,
	});
}
