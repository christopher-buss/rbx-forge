import path from "node:path";

import type { FlagDefinition } from "../cli/flags.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import type { HookedRun } from "../hooks/run-hooks.ts";
import { runWithHooksAsync } from "../hooks/run-hooks.ts";
import type { BuildTarget } from "../rojo/rojo.ts";
import { rojoBuildArgs, runRojoAsync } from "../rojo/rojo.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const BUILD_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "output",
		config: "buildOutputPath",
		kind: "string",
		short: "o",
		text: "The place or model file to write.",
		value: "<path>",
	},
	{
		name: "plugin",
		kind: "string",
		text: "Build into Studio's local plugins folder under this file name. Not with --output.",
		value: "<name>",
	},
];

/** What to build: the Rojo project and where the result goes. */
export interface BuildOptions {
	/** The Rojo project file, relative to the project root. */
	project: string;
	target: BuildTarget;
}

/** What one build produced. */
export interface BuildOutcome {
	durationMs: number;
	/** The absolute path of the output file, when not a plugin. */
	output?: string;
	/** The plugin file name, when built as a plugin. */
	plugin?: string;
}

/**
 * The build step with its `build` hooks. `forge build` runs it, and so does
 * every command that builds first (`open`, `start`), so the hooks apply
 * however a build is reached.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param config - The resolved config: Rojo command and hooks.
 * @param options - The project and target.
 * @returns The build outcome and every hook result.
 * @rejects {ForgeError} `rojo_missing`, `process_failed`, `hook_failed`, or
 *   `hook_depth_exceeded`.
 */
export async function buildAsync(
	context: CommandContext,
	config: ResolvedConfig,
	options: BuildOptions,
): Promise<HookedRun<BuildOutcome>> {
	return runWithHooksAsync(context, config, "build", async () => {
		const destination = prepareTarget(context, options.target);
		const args = rojoBuildArgs(options.project, options.target);
		const { durationMs } = await runRojoAsync(context, config, args);
		return { durationMs, ...destination };
	});
}

/**
 * `forge build`: build the Rojo project to the configured output, to
 * `--output`, or into the plugins folder with `--plugin`.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param input - The parsed flags.
 * @returns What was built and the hook results.
 * @rejects {ForgeError} `usage` for `--output` with `--plugin`, a config
 *   error, or a build failure from {@link buildAsync}.
 */
export async function runBuildCommandAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const { plugin } = input.flags;
	if (plugin !== undefined && input.flags["output"] !== undefined) {
		throw new ForgeError("usage", "--output and --plugin cannot be used together.", {
			hint: 'Run "forge build --help" for usage.',
		});
	}

	const { config } = await loadProjectConfigAsync(
		context.cwd,
		context.seams.configLoader,
		input.config,
	);
	const target: BuildTarget =
		typeof plugin === "string"
			? { plugin, type: "plugin" }
			: { output: config.buildOutputPath, type: "output" };
	const { hooks, value } = await buildAsync(context, config, {
		project: config.rojoProjectPath,
		target,
	});

	return {
		data: { ...value, hooks },
		summary:
			target.type === "plugin"
				? `Built plugin ${target.plugin}.`
				: `Built ${String(value.output)}.`,
	};
}

/**
 * Get the target ready for Rojo: an output file's folder must exist, since
 * Rojo does not create it.
 *
 * @param context - The run: project root and file system.
 * @param target - Where the build goes.
 * @returns The absolute output path, or the plugin name.
 */
function prepareTarget(
	context: CommandContext,
	target: BuildTarget,
): Pick<BuildOutcome, "output" | "plugin"> {
	if (target.type === "plugin") {
		return { plugin: target.plugin };
	}

	const output = path.resolve(context.cwd, target.output);
	context.seams.fileSystem.mkdirSync(path.dirname(output), { recursive: true });
	return { output };
}
