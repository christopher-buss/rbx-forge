import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import type { Invocation } from "../process/command-line.ts";
import type { ToolCall, ToolSuccess } from "../process/run-tool.ts";
import { resolveInvocation, runToolAsync } from "../process/run-tool.ts";

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
	return runToolAsync(context, rojoCall(config, args));
}

/**
 * The arguments of `rojo serve` on a fixed port. Rojo fails when the port is
 * busy; it never picks another (#27).
 *
 * @param project - The Rojo project file.
 * @param port - The port to serve on.
 * @returns Arguments after the Rojo command.
 */
export function rojoServeArgs(project: string, port: number): RojoArgs {
	return ["serve", project, "--port", String(port)];
}

/**
 * What starts a Rojo subcommand with the configured Rojo command, for a
 * worker that outlives one step, such as `rojo serve`.
 *
 * @param context - The project root, environment, and seams.
 * @param config - Holds `rojoAlias`.
 * @param args - The subcommand and its arguments.
 * @returns The executable and arguments to spawn.
 * @throws `rojo_missing` when Rojo is not installed.
 */
export function rojoInvocation(
	context: Pick<CommandContext, "cwd" | "env" | "seams">,
	config: Pick<ResolvedConfig, "rojoAlias">,
	args: RojoArgs,
): Invocation {
	return resolveInvocation(context, rojoCall(config, args));
}

function rojoCall(config: Pick<ResolvedConfig, "rojoAlias">, args: RojoArgs): ToolCall {
	return {
		args,
		command: config.rojoAlias,
		label: "Rojo",
		missing: "rojo_missing",
		missingHint: MISSING_HINT,
		step: `rojo ${args[0]}`,
	};
}
