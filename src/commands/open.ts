import path from "node:path";

import type { FlagDefinition } from "../cli/flags.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import type { HookResult } from "../hooks/run-hooks.ts";
import { runWithHooksAsync } from "../hooks/run-hooks.ts";
import type { CommandResult } from "../seams/reporter.ts";
import { STUDIO_PATH_FLAG } from "../studio/discover.ts";
import type { StudioProcess } from "../studio/launcher.ts";
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
	STUDIO_PATH_FLAG,
];

/** A build that ran before the place opened, with its `build` hooks. */
export interface OpenBuild extends BuildOutcome {
	hooks: Array<HookResult>;
}

/** What the open step did. */
export interface OpenedPlace {
	/** The build that ran first, or `null`. */
	build: null | OpenBuild;
	/** The `open` hook results. */
	hooks: Array<HookResult>;
	/** The absolute path of the place. */
	place: string;
	/** The Studio forge started directly; `null` for the platform launcher. */
	studio: null | StudioProcess;
}

/** How the open step runs. */
export interface OpenOptions {
	/** The caller already built this place, so it is opened as it is. */
	isBuilt: boolean;
	/** The `--studio-path` flag, resolved. */
	studioPath?: string | undefined;
}

/** The place, as the config names it and as an absolute path. */
interface Place {
	/** Relative to the project root, as Rojo gets it. */
	output: string;
	place: string;
}

const STEP = "open Roblox Studio";

/**
 * The open step with its `open` hooks: build the place when configured or
 * missing (unless the caller built it), then open it in Studio. `forge open`
 * runs it, and so does `forge start`.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param config - The resolved config: the place, the build, and the hooks.
 * @param options - Whether it is built, and the Studio executable flag.
 * @returns The place, the build (or `null`), the Studio forge started, and
 *   the `open` hook results.
 * @rejects {ForgeError} `place_not_found`, `declined`, `studio_launch_failed`, a build
 *   failure from `buildAsync`, or a hook failure.
 */
export async function openPlaceAsync(
	context: CommandContext,
	config: ResolvedConfig,
	options: OpenOptions,
): Promise<OpenedPlace> {
	const output = openPlacePath(config);
	const place = path.resolve(context.cwd, output);

	const { hooks, value } = await runWithHooksAsync(context, config, "open", async () => {
		const built = options.isBuilt
			? null
			: await prepareAsync(context, config, { output, place });
		const studio = await launchAsync(context, place, options.studioPath);
		return { built, studio };
	});

	return { build: value.built, hooks, place, studio: value.studio };
}

/**
 * `forge open`: open the place file in Roblox Studio, building it first when
 * `open.buildFirst` or `--build` asks. Studio starts detached
 * (`seams.studioLauncher`), so it is never a child of forge and outlives it. A
 * missing place is built when the user agrees; a run that cannot ask fails.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param input - The config values the flags set.
 * @returns The place, the build (or `null`), and the `open` hook results.
 * @rejects {ForgeError} `place_not_found`, `declined`, `studio_launch_failed`, a build
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
	const studioPath = input.flags["studio-path"];
	const opened = await openPlaceAsync(context, config, {
		isBuilt: false,
		studioPath:
			typeof studioPath === "string" ? path.resolve(context.cwd, studioPath) : undefined,
	});

	return {
		data: { ...opened },
		summary: `Opened ${opened.place} in Roblox Studio.`,
	};
}

/**
 * The place `forge open` opens, as the config names it.
 *
 * @param config - The resolved config.
 * @returns `open.buildOutputPath`, else `buildOutputPath`.
 */
function openPlacePath(config: Pick<ResolvedConfig, "buildOutputPath" | "open">): string {
	return config.open.buildOutputPath ?? config.buildOutputPath;
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

	const answer = await askAsync<"build" | "declined" | "unasked">(context, {
		ask: async (prompter) => {
			const shouldBuild = await prompter.confirm(
				`${place} does not exist. Build it now?`,
				true,
			);
			return shouldBuild ? "build" : "declined";
		},
		unattended: { answer: "unasked" },
	});
	const hint = 'Build it first: run "forge open --build" or "forge build".';
	if (answer === "declined") {
		throw new ForgeError("declined", `${place} does not exist, and it was not built.`, {
			hint,
		});
	}

	if (answer === "unasked") {
		throw new ForgeError("place_not_found", `${place} does not exist.`, { hint });
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
 * @rejects {ForgeError} `place_not_found`, `declined`, or a build failure.
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
	studioPath: string | undefined,
): Promise<null | StudioProcess> {
	reporter.emit({ name: STEP, status: "started", type: "step" });
	const outcome = await seams.studioLauncher({ cwd, env, place, studioPath });
	reporter.emit({
		name: STEP,
		status: outcome.type === "launched" ? "succeeded" : "failed",
		type: "step",
	});

	if (outcome.type === "failed") {
		throw new ForgeError(
			"studio_launch_failed",
			`Could not open ${place} in Roblox Studio: ${outcome.message}`,
			{
				hint:
					outcome.hint ?? "Check that Roblox Studio is installed and opens .rbxl files.",
			},
		);
	}

	return outcome.studio ?? null;
}
