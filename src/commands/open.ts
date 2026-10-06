import path from "node:path";

import type { FlagDefinition } from "../cli/flags.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { resolveStudioDesktop } from "../config/resolve.ts";
import type { StudioDesktop } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import type { HookResult } from "../hooks/run-hooks.ts";
import { runWithHooksAsync } from "../hooks/run-hooks.ts";
import type { CommandResult } from "../seams/reporter.ts";
import { STUDIO_PATH_FLAG } from "../studio/discover.ts";
import type { StudioLaunchOutcome, StudioProcess } from "../studio/launcher.ts";
import { pruneSnapshots, snapshotName } from "../studio/snapshots.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import { askAsync } from "./ask.ts";
import type { BuildOutcome } from "./build.ts";
import { buildAsync } from "./build.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const OPEN_FLAGS: ReadonlyArray<FlagDefinition> = [
	STUDIO_PATH_FLAG,
	{
		name: "desktop",
		config: "studio.desktop",
		kind: "string",
		text: "Studio desktop (default: hidden on Windows and macOS).",
		value: "user|hidden",
	},
];

/** A build that ran before the place opened, with its `build` hooks. */
export interface OpenBuild extends BuildOutcome {
	hooks: Array<HookResult>;
}

/** What `forge open` did. */
export interface OpenedSnapshot {
	build: OpenBuild;
	desktop: StudioDesktop;
	/** The `open` hook results. */
	hooks: Array<HookResult>;
	/** The absolute path of the snapshot. */
	place: string;
	/** The old snapshots it deleted. */
	pruned: Array<string>;
	/** The Studio forge started directly; `null` for the platform launcher. */
	studio: null | StudioProcess;
}

/** What the open step did. */
export interface OpenedPlace {
	/** The build that ran first, or `null`. */
	build: null | OpenBuild;
	desktop: StudioDesktop;
	/** The `open` hook results. */
	hooks: Array<HookResult>;
	/** The absolute path of the place. */
	place: string;
	/** The Studio forge started directly; `null` for the platform launcher. */
	studio: null | StudioProcess;
}

/** How the open step runs. */
export interface OpenOptions {
	/** Prepare a session plugin immediately before a direct launch attempt. */
	beforeLaunch?: (() => Promise<void>) | undefined;
	desktop?: StudioDesktop | undefined;
	/** The caller already built this place, so it is opened as it is. */
	isBuilt: boolean;
	/** A session's marker script; snapshots do not use one. */
	runScript?: string | undefined;
	/**
	 * A session's end, checked just before launching Studio outside its
	 * reaper.
	 */
	signal?: AbortSignal;
	/** The `--studio-path` flag, resolved. */
	studioPath?: string | undefined;
	/**
	 * Watch a snapshot's delayed hidden-desktop Lighting prompt after the CLI
	 * exits.
	 */
	watchHiddenLighting?: boolean | undefined;
}

/** The place, as the config names it and as an absolute path. */
interface Place {
	/** Relative to the project root, as Rojo gets it. */
	output: string;
	place: string;
}

const STEP = "open Roblox Studio";

/**
 * The place a session's Studio opens, as the config names it; snapshots take
 * its file name.
 *
 * @param config - The resolved config.
 * @returns `open.buildOutputPath`, else `buildOutputPath`.
 */
export function openPlacePath(config: Pick<ResolvedConfig, "buildOutputPath" | "open">): string {
	return config.open.buildOutputPath ?? config.buildOutputPath;
}

/**
 * The open step with its `open` hooks: build the place when configured or
 * missing (unless the caller built it), then open it in Studio. A session's
 * Studio opens through it.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param config - The resolved config: the place, the build, and the hooks.
 * @param options - Whether it is built, and the Studio executable flag.
 * @returns The place, the build (or `null`), the Studio forge started, and
 *   the `open` hook results.
 * @rejects {ForgeError} `place_not_found`, `declined`, `studio_launch_failed`,
 *   `native_missing`, a build failure from `buildAsync`, or a hook failure.
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
		options.signal?.throwIfAborted();
		const launched = await launchAsync(context, place, options);
		return { built, ...launched };
	});

	return { build: value.built, desktop: value.desktop, hooks, place, studio: value.studio };
}

/**
 * `forge open`: build a snapshot of the place into `.forge/snapshots/`, keep
 * the five newest (and every one a Studio has open),
 * and open it in Roblox Studio. It runs outside every session and with no
 * Rojo, so it never shares a place file with a session's Studio. Studio
 * starts detached (`seams.studioLauncher`), so it is never a child of forge
 * and outlives it.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param input - `--studio-path` and the config values flags set.
 * @returns The snapshot, its build, the snapshots it deleted, the Studio
 *   forge started, and the `open` hook results.
 * @rejects {ForgeError} `studio_launch_failed`, `native_missing`, a build
 *   failure from `buildAsync`, a hook failure, or a config error.
 */
export async function runOpenAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const { cwd, reporter, seams } = context;
	const { config } = await loadProjectConfigAsync(cwd, seams.configLoader, input.config);
	const studioPath = input.flags["studio-path"];
	const { snapshots } = forgeFiles(cwd);
	const place = path.join(snapshots, snapshotName(seams.clock.now(), openPlacePath(config)));

	const { hooks, value } = await runWithHooksAsync(context, config, "open", async () => {
		const build = await buildAsync(context, config, {
			project: config.open.projectPath ?? config.rojoProjectPath,
			target: { output: path.relative(cwd, place), type: "output" },
		});
		const { pruned, warnings } = pruneSnapshots(seams.fileSystem, snapshots);
		for (const message of warnings) {
			reporter.emit({ message, type: "warning" });
		}

		const launched = await launchAsync(context, place, {
			desktop: resolveStudioDesktop(config, seams.host.platform, "hidden"),
			studioPath: typeof studioPath === "string" ? path.resolve(cwd, studioPath) : undefined,
			watchHiddenLighting: true,
		});

		return { build: { ...build.value, hooks: build.hooks }, pruned, ...launched };
	});
	const opened: OpenedSnapshot = { ...value, hooks, place };

	return { data: { ...opened }, summary: `Opened a snapshot, ${place}, in Roblox Studio.` };
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
	const hint = 'Build it first: run "forge build", or set open.buildFirst.';
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

/**
 * Report a fallback warning and return Studio's actual launch location.
 *
 * @param reporter - The command's reporter.
 * @param outcome - The successful launch.
 * @returns The actual desktop and any pinned Studio.
 */
function reportLaunch(
	reporter: CommandContext["reporter"],
	outcome: Extract<StudioLaunchOutcome, { type: "launched" }>,
): Pick<OpenedPlace, "desktop" | "studio"> {
	if (outcome.warning !== undefined) {
		reporter.emit({ message: outcome.warning, type: "warning" });
	}

	return {
		desktop: outcome.desktop ?? outcome.studio?.desktop ?? "user",
		studio: outcome.studio ?? null,
	};
}

async function launchAsync(
	{ cwd, env, reporter, seams }: CommandContext,
	place: string,
	{
		beforeLaunch,
		desktop,
		runScript,
		studioPath,
		watchHiddenLighting,
	}: Pick<
		OpenOptions,
		"beforeLaunch" | "desktop" | "runScript" | "studioPath" | "watchHiddenLighting"
	>,
): Promise<Pick<OpenedPlace, "desktop" | "studio">> {
	reporter.emit({ name: STEP, status: "started", type: "step" });
	const outcome = await seams.studioLauncher({
		cwd,
		env,
		place,
		studioPath,
		...(desktop === undefined ? {} : { desktop }),
		...(watchHiddenLighting === undefined ? {} : { watchHiddenLighting }),
		...(runScript === undefined ? {} : { runScript }),
		...(beforeLaunch === undefined ? {} : { beforeLaunch }),
	});
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

	return reportLaunch(reporter, outcome);
}
