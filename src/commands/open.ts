import path from "node:path";

import type { FlagDefinition } from "../cli/flags.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import type { HookResult } from "../hooks/run-hooks.ts";
import { runWithHooksAsync } from "../hooks/run-hooks.ts";
import type { CommandResult } from "../seams/reporter.ts";
import { askAsync } from "./ask.ts";
import type { BuildOutcome } from "./build.ts";
import { buildAsync } from "./build.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const OPEN_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "place",
		config: "open.buildOutputPath",
		kind: "string",
		text: "The place file to open (and to build, when building first).",
		value: "<path>",
	},
	{
		name: "build",
		config: "open.buildFirst",
		kind: "boolean",
		text: "Build the place before opening it; --no-build opens it as it is.",
	},
];

/** A build that ran before the place opened, with its `build` hooks. */
interface OpenBuild extends BuildOutcome {
	hooks: Array<HookResult>;
}

/** The place, as the config names it and as an absolute path. */
interface Place {
	/** Relative to the project root, as Rojo gets it. */
	output: string;
	place: string;
}

const STEP = "open Roblox Studio";

/**
 * `forge open`: open the place file in Roblox Studio, building it first when
 * `open.buildFirst` or `--build` asks. Studio starts through the platform
 * launcher (`seams.studioLauncher`), so it is never a child of forge and
 * outlives it. A missing place is built when the user agrees; a run that
 * cannot ask fails.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param input - The config values the flags set.
 * @returns The place, the build (or `null`), and the `open` hook results.
 * @rejects {ForgeError} `place_not_found`, `studio_launch_failed`, a build
 *   failure from `buildAsync`, a hook failure, or a config error.
 */
export async function runOpenAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const { config } = await loadProjectConfigAsync(
		context.cwd,
		context.seams.configLoader,
		input.config,
	);
	const output = config.open.buildOutputPath ?? config.buildOutputPath;
	const place = path.resolve(context.cwd, output);

	const { hooks, value: build } = await runWithHooksAsync(context, config, "open", async () => {
		const built = await prepareAsync(context, config, { output, place });
		await launchAsync(context, place);
		return built;
	});

	return {
		data: { build, hooks, place },
		summary: `Opened ${place} in Roblox Studio.`,
	};
}

async function shouldBuildAsync(
	context: CommandContext,
	config: ResolvedConfig,
	place: string,
): Promise<boolean> {
	if (config.open.buildFirst) {
		return true;
	}

	if (context.seams.fileSystem.existsSync(place)) {
		return false;
	}

	const shouldBuild = await askAsync(context, {
		ask: async (prompter) => prompter.confirm(`${place} does not exist. Build it now?`, true),
		unattended: { answer: false },
	});
	if (!shouldBuild) {
		throw new ForgeError("place_not_found", `${place} does not exist.`, {
			hint: 'Build it first: run "forge open --build" or "forge build".',
		});
	}

	return true;
}

/**
 * Build the place when asked to, or when it is missing and the user agrees.
 *
 * @param context - The run.
 * @param config - The resolved config.
 * @param target - The place to build.
 * @returns The build, or `null` when none ran.
 * @rejects {ForgeError} `place_not_found`, or a build failure.
 */
async function prepareAsync(
	context: CommandContext,
	config: ResolvedConfig,
	{ output, place }: Place,
): Promise<null | OpenBuild> {
	if (!(await shouldBuildAsync(context, config, place))) {
		return null;
	}

	const { hooks, value } = await buildAsync(context, config, {
		project: config.open.projectPath ?? config.rojoProjectPath,
		target: { output, type: "output" },
	});
	return { ...value, hooks };
}

async function launchAsync(
	{ cwd, env, reporter, seams }: CommandContext,
	place: string,
): Promise<void> {
	reporter.emit({ name: STEP, status: "started", type: "step" });
	const outcome = await seams.studioLauncher({ cwd, env, place });
	reporter.emit({
		name: STEP,
		status: outcome.type === "launched" ? "succeeded" : "failed",
		type: "step",
	});

	if (outcome.type === "failed") {
		throw new ForgeError(
			"studio_launch_failed",
			`Could not open ${place} in Roblox Studio: ${outcome.message}`,
			{ hint: "Check that Roblox Studio is installed and opens .rbxl files." },
		);
	}
}
