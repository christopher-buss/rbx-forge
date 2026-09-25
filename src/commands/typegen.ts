import path from "node:path";

import type { FlagDefinition } from "../cli/flags.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import { runWithHooksAsync } from "../hooks/run-hooks.ts";
import { rojoSourcemapArgs, runRojoAsync } from "../rojo/rojo.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { GeneratedTypes } from "../typegen/generate.ts";
import { generateServiceTypes } from "../typegen/generate.ts";
import { parseSourcemap } from "../typegen/sourcemap.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const TYPEGEN_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "output",
		config: "typegen.outputPath",
		kind: "string",
		short: "o",
		text: "The declaration file to write.",
		value: "<path>",
	},
	{
		name: "include",
		config: "typegen.include",
		kind: "list",
		text: "Type instances whose path matches this glob, such as ReplicatedStorage/**. Repeat for more; replaces the config's list.",
		value: "<glob>",
	},
	{
		name: "exclude",
		config: "typegen.exclude",
		kind: "list",
		text: "Leave out instances whose path matches this glob, with everything under them. Repeat for more; replaces the config's list.",
		value: "<glob>",
	},
	{
		name: "max-depth",
		config: "typegen.maxDepth",
		kind: "number",
		text: "The deepest instance level to type; a service is level 1.",
		value: "<n>",
	},
];

/**
 * Where Rojo writes the sourcemap, relative to the project root. Relative, so
 * a Windows Rojo run from WSL reads it too. Removed after each run.
 */
const SOURCEMAP_FILE = path.join(".forge", "sourcemap.json");

/** What one typegen run wrote. */
type TypegenOutcome = Pick<GeneratedTypes, "duplicates" | "services"> & {
	/** How long `rojo sourcemap` took. */
	durationMs: number;
	/** The absolute path of the declaration file. */
	output: string;
};

/**
 * `forge typegen`: write TypeScript types for the services of the Rojo
 * project, from `rojo sourcemap`, filtered by `typegen.include`,
 * `typegen.exclude`, and `typegen.maxDepth`.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param input - The parsed flags.
 * @returns What was written and the hook results.
 * @rejects {ForgeError} A config error, `command_unavailable` for a Luau
 *   project, `rojo_missing`, `process_failed`, `sourcemap_invalid`,
 *   `hook_failed`, or `hook_depth_exceeded`.
 */
export async function runTypegenCommandAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const { config } = await loadProjectConfigAsync(
		context.cwd,
		context.seams.configLoader,
		input.config,
	);
	if (config.projectType === "luau") {
		throw new ForgeError(
			"command_unavailable",
			"forge typegen writes TypeScript declarations, which a Luau project does not use.",
			{ hint: 'forge typegen applies only when projectType is "rbxts".' },
		);
	}

	const { hooks, value } = await runWithHooksAsync(context, config, "typegen", async () => {
		return typegenAsync(context, config);
	});
	for (const duplicate of value.duplicates) {
		context.reporter.emit({
			message: `Skipped ${duplicate}: an earlier sibling has the same name, and a type can hold only one.`,
			type: "warning",
		});
	}

	return { data: { ...value, hooks }, summary: `Wrote ${value.output}.` };
}

/**
 * Run `rojo sourcemap` and read what it wrote. The file is removed whether or
 * not it can be read.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param config - The Rojo command and project.
 * @returns The sourcemap's text and how long Rojo took.
 * @rejects {ForgeError} `rojo_missing`, `process_failed`, or
 *   `sourcemap_invalid` when Rojo wrote no file.
 */
async function readSourcemapAsync(
	context: CommandContext,
	config: ResolvedConfig,
): Promise<{ durationMs: number; text: string }> {
	const { fileSystem } = context.seams;
	const file = path.join(context.cwd, SOURCEMAP_FILE);
	fileSystem.mkdirSync(path.dirname(file), { recursive: true });
	const args = rojoSourcemapArgs(config.rojoProjectPath, SOURCEMAP_FILE);
	const { durationMs } = await runRojoAsync(context, config, args);

	try {
		return { durationMs, text: fileSystem.readFileSync(file, "utf8") };
	} catch (err) {
		throw new ForgeError(
			"sourcemap_invalid",
			`Rojo exited without writing the sourcemap to ${SOURCEMAP_FILE}.`,
			{ cause: err, hint: "Check that rojoAlias runs Rojo, not another tool." },
		);
	} finally {
		fileSystem.rmSync(file, { force: true });
	}
}

async function typegenAsync(
	context: CommandContext,
	config: ResolvedConfig,
): Promise<TypegenOutcome> {
	const { durationMs, text } = await readSourcemapAsync(context, config);
	const { duplicates, services, source } = generateServiceTypes(
		parseSourcemap(text, SOURCEMAP_FILE),
		config.typegen,
	);

	const output = path.resolve(context.cwd, config.typegen.outputPath);
	context.seams.fileSystem.mkdirSync(path.dirname(output), { recursive: true });
	context.seams.fileSystem.writeFileSync(output, source);
	return { duplicates, durationMs, output, services };
}
