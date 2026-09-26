import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	createCommandContext,
	createMemoryFileSystem,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { MemoryFileSystem, RecordingReporter } from "../../test/helpers/seams.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import type { ConfigLayer } from "../config/schema.ts";
import type { ProcessOutcome, ProcessRunner, ProcessSpec } from "../process/process-runner.ts";
import type { ConfigLoader } from "../seams/config-loader.ts";
import type { Prompter } from "../seams/prompter.ts";
import type { StudioLauncher, StudioLaunchOutcome } from "../studio/launcher.ts";
import type { CommandContext, CommandInput } from "./context.ts";
import type { OpenedPlace } from "./open.ts";
import { openPlaceAsync, runOpenAsync } from "./open.ts";

const TOOLS = path.join(PROJECT, "tools");
const GAME = path.join(PROJECT, "game.rbxl");
const SNAPSHOTS = path.join(PROJECT, ".forge", "snapshots");
/** The snapshot's name at the test clock's time. */
const SNAPSHOT_NAME = "2026-01-01T00-00-00-000_game.rbxl";
const SNAPSHOT = path.join(SNAPSHOTS, SNAPSHOT_NAME);
const SNAPSHOT_OUTPUT = path.join(".forge", "snapshots", SNAPSHOT_NAME);

interface OpenSetup {
	/** The answer to "build it now?", for an interactive run. */
	answer?: boolean;
	/** The config file's content besides `projectType`. */
	file?: object;
	/** Extra files besides the Rojo executable. */
	files?: Record<string, string>;
	/** What the launcher reports. */
	launch?: StudioLaunchOutcome;
	/** What each spawn returns, by its label (`rojo` or a hook). */
	outcomes?: Record<string, ProcessOutcome>;
}

interface OpenRun {
	confirm: ReturnType<typeof vi.fn<Prompter["confirm"]>>;
	context: CommandContext;
	launcher: ReturnType<typeof vi.fn<StudioLauncher>>;
	memory: MemoryFileSystem;
	/** What ran, in order: `rojo`, `studio`, or a hook's command line. */
	order: Array<string>;
	reporter: RecordingReporter;
	specs: Array<ProcessSpec>;
}

function exited(exitCode: number, outputTail: Array<string> = []): ProcessOutcome {
	return { durationMs: 900, exitCode, outputTail, signal: null, type: "exited" };
}

function labelOf(spec: ProcessSpec): string {
	return spec.file === "/bin/sh" ? spec.args[1]! : "rojo";
}

function makeOpen({
	answer,
	file = {},
	files = { "tools/rojo": "" },
	launch = { type: "launched" },
	outcomes = {},
}: OpenSetup = {}): OpenRun {
	const memory = createMemoryFileSystem(files);
	const order: Array<string> = [];
	const specs: Array<ProcessSpec> = [];
	const processRunner = vi.fn<ProcessRunner>(async (spec) => {
		specs.push(spec);
		order.push(labelOf(spec));
		const outcome = outcomes[labelOf(spec)] ?? exited(0);
		const [command, , flag, output] = spec.args;
		// Rojo writes the place it built.
		if (command === "build" && flag === "--output") {
			memory.fileSystem.writeFileSync(path.resolve(PROJECT, output!), "place");
		}

		return outcome;
	});
	const launcher = vi.fn<StudioLauncher>(async () => {
		order.push("studio");
		return launch;
	});
	const configLoader = vi.fn<ConfigLoader>().mockResolvedValue({
		path: path.join(PROJECT, "rbx-forge.config.ts"),
		value: { projectType: "rbxts", ...file },
	});
	const confirm = vi.fn<Prompter["confirm"]>().mockResolvedValue(answer ?? false);
	const reporter = createRecordingReporter();

	return {
		confirm,
		context: createCommandContext({
			env: { PATH: TOOLS },
			interactive: answer !== undefined,
			reporter,
			seams: createTestSeams({
				configLoader,
				fileSystem: memory.fileSystem,
				processRunner,
				prompter: { choose: vi.fn<Prompter["choose"]>(), confirm },
				studioLauncher: launcher,
			}),
		}),
		launcher,
		memory,
		order,
		reporter,
		specs,
	};
}

function input(config: ConfigLayer = {}): CommandInput {
	return { config, flags: {} };
}

const NO_BUILD: ConfigLayer = { open: { buildFirst: false } };

/**
 * Run the open step as a session's Studio does.
 *
 * @param context - The run.
 * @param layer - The config values flags set.
 * @param isBuilt - Whether the caller built the place.
 * @returns What it did.
 */
async function openStepAsync(
	context: CommandContext,
	layer: ConfigLayer = {},
	isBuilt = false,
): Promise<OpenedPlace> {
	const { config } = await loadProjectConfigAsync(context.cwd, context.seams.configLoader, layer);
	return openPlaceAsync(context, config, { isBuilt });
}

/**
 * Seed files: `count` old snapshots.
 *
 * @param count - How many.
 * @returns Their files, with the Rojo executable.
 */
function oldSnapshots(count: number): Record<string, string> {
	const files: Record<string, string> = { "tools/rojo": "" };
	for (let index = 0; index < count; index++) {
		files[`.forge/snapshots/2025-01-01T00-00-0${index}-000_game.rbxl`] = "place";
	}

	return files;
}

describe(runOpenAsync, () => {
	it("should build a snapshot into .forge/snapshots, then open it", async () => {
		expect.assertions(3);

		const { context, launcher, order, specs } = makeOpen();

		await expect(runOpenAsync(context, input())).resolves.toStrictEqual({
			data: {
				build: { durationMs: 900, hooks: [], output: SNAPSHOT },
				hooks: [],
				place: SNAPSHOT,
				pruned: [],
				studio: null,
			},
			summary: `Opened a snapshot, ${SNAPSHOT}, in Roblox Studio.`,
		});
		expect(specs[0]!.args).toStrictEqual([
			"build",
			"default.project.json",
			"--output",
			SNAPSHOT_OUTPUT,
		]);
		expect({ launches: launcher.mock.calls, order }).toStrictEqual({
			launches: [
				[{ cwd: PROJECT, env: { PATH: TOOLS }, place: SNAPSHOT, studioPath: undefined }],
			],
			order: ["rojo", "studio"],
		});
	});

	it("should build a snapshot even when the config turns buildFirst off and the place exists", async () => {
		expect.assertions(1);

		const { context, order } = makeOpen({
			file: NO_BUILD,
			files: { "game.rbxl": "place", "tools/rojo": "" },
		});
		await runOpenAsync(context, input());

		expect(order).toStrictEqual(["rojo", "studio"]);
	});

	it("should build the snapshot from open.projectPath and name it after open.buildOutputPath", async () => {
		expect.assertions(2);

		const { context, launcher, specs } = makeOpen({
			file: {
				buildOutputPath: "other.rbxl",
				open: { buildOutputPath: "places/test.rbxlx", projectPath: "test.project.json" },
			},
		});
		await runOpenAsync(context, input());

		expect(specs[0]!.args).toStrictEqual([
			"build",
			"test.project.json",
			"--output",
			path.join(".forge", "snapshots", "2026-01-01T00-00-00-000_test.rbxlx"),
		]);
		expect(launcher.mock.calls[0]![0].place).toBe(
			path.join(SNAPSHOTS, "2026-01-01T00-00-00-000_test.rbxlx"),
		);
	});

	it("should keep the five newest snapshots and report the ones it deleted", async () => {
		expect.assertions(2);

		const { context, memory } = makeOpen({ files: oldSnapshots(6) });
		const { data } = await runOpenAsync(context, input());

		expect(data).toMatchObject({
			pruned: [
				path.join(SNAPSHOTS, "2025-01-01T00-00-00-000_game.rbxl"),
				path.join(SNAPSHOTS, "2025-01-01T00-00-01-000_game.rbxl"),
			],
		});
		expect(memory.fileSystem.readdirSync(SNAPSHOTS)).toStrictEqual([
			"2025-01-01T00-00-02-000_game.rbxl",
			"2025-01-01T00-00-03-000_game.rbxl",
			"2025-01-01T00-00-04-000_game.rbxl",
			"2025-01-01T00-00-05-000_game.rbxl",
			SNAPSHOT_NAME,
		]);
	});

	it("should warn about a snapshot it cannot delete, and still open", async () => {
		expect.assertions(3);

		const name = "2024-01-01T00-00-00-000_game.rbxl";
		const old = path.join(SNAPSHOTS, name);
		// A folder with a place's name: deleting it as a file fails.
		const { context, order, reporter } = makeOpen({
			files: { ...oldSnapshots(4), [`.forge/snapshots/${name}/inner`]: "" },
		});
		await runOpenAsync(context, input());

		const warnings = reporter.events.filter(({ type }) => type === "warning");

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toHaveProperty(
			"message",
			expect.stringContaining(`Could not delete ${old}: `),
		);
		expect(order).toStrictEqual(["rojo", "studio"]);
	});

	it("should start the Studio --studio-path names, and report it", async () => {
		expect.assertions(2);

		const { context, launcher } = makeOpen({
			launch: { studio: { pid: 7, startTime: "70" }, type: "launched" },
		});

		await expect(
			runOpenAsync(context, { config: {}, flags: { "studio-path": "bin/Studio.exe" } }),
		).resolves.toMatchObject({ data: { studio: { pid: 7, startTime: "70" } } });
		expect(launcher.mock.calls[0]![0].studioPath).toBe(path.join(PROJECT, "bin/Studio.exe"));
	});

	it("should report the build and opening Studio as steps", async () => {
		expect.assertions(1);

		const { context, reporter } = makeOpen();
		await runOpenAsync(context, input());

		expect(reporter.events).toStrictEqual([
			{ name: "rojo build", status: "started", type: "step" },
			{ name: "rojo build", status: "succeeded", type: "step" },
			{ name: "open Roblox Studio", status: "started", type: "step" },
			{ name: "open Roblox Studio", status: "succeeded", type: "step" },
		]);
	});

	it("should pass on the launcher's hint", async () => {
		expect.assertions(1);

		const { context } = makeOpen({
			launch: { hint: "Fix it.", message: "--studio-path names x.", type: "failed" },
		});

		await expect(runOpenAsync(context, input())).rejects.toMatchObject({
			hint: "Fix it.",
		});
	});

	it("should not open Studio when the build fails", async () => {
		expect.assertions(2);

		const { context, launcher } = makeOpen({ outcomes: { rojo: exited(1) } });

		await expect(runOpenAsync(context, input())).rejects.toMatchObject({
			code: "process_failed",
		});
		expect(launcher).not.toHaveBeenCalled();
	});

	it("should fail with studio_launch_failed when the launcher fails", async () => {
		expect.assertions(2);

		const { context, reporter } = makeOpen({
			launch: { message: "xdg-open exited with code 4.", type: "failed" },
		});

		await expect(runOpenAsync(context, input())).rejects.toMatchObject({
			code: "studio_launch_failed",
			hint: "Check that Roblox Studio is installed and opens .rbxl files.",
			message: `Could not open ${SNAPSHOT} in Roblox Studio: xdg-open exited with code 4.`,
		});
		expect(reporter.events).toStrictEqual([
			{ name: "rojo build", status: "started", type: "step" },
			{ name: "rojo build", status: "succeeded", type: "step" },
			{ name: "open Roblox Studio", status: "started", type: "step" },
			{ name: "open Roblox Studio", status: "failed", type: "step" },
		]);
	});

	it("should run open hooks around the build and the launch, and build hooks around the build", async () => {
		expect.assertions(2);

		const { context, order } = makeOpen({
			file: {
				hooks: {
					build: { post: ["build-post"], pre: ["build-pre"] },
					open: { post: ["open-post"], pre: ["open-pre"] },
				},
			},
		});
		const { data } = await runOpenAsync(context, input());

		expect(order).toStrictEqual([
			"open-pre",
			"build-pre",
			"rojo",
			"build-post",
			"studio",
			"open-post",
		]);
		expect(data).toMatchObject({
			build: {
				hooks: [
					expect.objectContaining({ id: "build:pre:0" }),
					expect.objectContaining({ id: "build:post:0" }),
				],
			},
			hooks: [
				expect.objectContaining({ id: "open:pre:0" }),
				expect.objectContaining({ id: "open:post:0" }),
			],
		});
	});

	it("should skip open post hooks when the launch fails", async () => {
		expect.assertions(2);

		const { context, order } = makeOpen({
			file: { hooks: { open: { post: ["open-post"] } } },
			launch: { message: "no", type: "failed" },
		});

		await expect(runOpenAsync(context, input())).rejects.toMatchObject({
			code: "studio_launch_failed",
		});
		expect(order).toStrictEqual(["rojo", "studio"]);
	});
});

describe(openPlaceAsync, () => {
	it("should build the place first by default, then open it", async () => {
		expect.assertions(3);

		const { context, launcher, order, specs } = makeOpen();

		await expect(openStepAsync(context)).resolves.toStrictEqual({
			build: { durationMs: 900, hooks: [], output: GAME },
			hooks: [],
			place: GAME,
			studio: null,
		});
		expect(specs[0]!.args).toStrictEqual([
			"build",
			"default.project.json",
			"--output",
			"game.rbxl",
		]);
		expect({ launches: launcher.mock.calls, order }).toStrictEqual({
			launches: [
				[{ cwd: PROJECT, env: { PATH: TOOLS }, place: GAME, studioPath: undefined }],
			],
			order: ["rojo", "studio"],
		});
	});

	it("should open the place as it is when the caller built it", async () => {
		expect.assertions(1);

		const { context, order } = makeOpen();
		await openStepAsync(context, {}, true);

		expect(order).toStrictEqual(["studio"]);
	});

	it("should open an existing place without building when buildFirst is off", async () => {
		expect.assertions(2);

		const { context, order } = makeOpen({ files: { "game.rbxl": "place" } });

		await expect(openStepAsync(context, NO_BUILD)).resolves.toStrictEqual({
			build: null,
			hooks: [],
			place: GAME,
			studio: null,
		});
		expect(order).toStrictEqual(["studio"]);
	});

	it("should build and open the given place from its own project", async () => {
		expect.assertions(2);

		const place = path.join(PROJECT, "places", "test.rbxl");
		const { context, launcher, specs } = makeOpen({
			file: { buildOutputPath: "other.rbxl", open: { projectPath: "test.project.json" } },
		});
		await openStepAsync(context, { open: { buildOutputPath: "places/test.rbxl" } });

		expect(specs[0]!.args).toStrictEqual([
			"build",
			"test.project.json",
			"--output",
			"places/test.rbxl",
		]);
		expect(launcher.mock.calls[0]![0].place).toBe(place);
	});

	it("should fail with place_not_found when the place is missing and it cannot ask", async () => {
		expect.assertions(2);

		const { context, launcher } = makeOpen();

		await expect(openStepAsync(context, NO_BUILD)).rejects.toMatchObject({
			code: "place_not_found",
			hint: 'Build it first: run "forge build", or set open.buildFirst.',
			message: `${GAME} does not exist.`,
		});
		expect(launcher).not.toHaveBeenCalled();
	});

	it("should offer to build a missing place and build it when the user agrees", async () => {
		expect.assertions(2);

		const { confirm, context, order } = makeOpen({ answer: true });
		await openStepAsync(context, NO_BUILD);

		expect(confirm).toHaveBeenCalledExactlyOnceWith(
			`${GAME} does not exist. Build it now?`,
			true,
		);
		expect(order).toStrictEqual(["rojo", "studio"]);
	});

	it("should fail with declined when the user declines the build", async () => {
		expect.assertions(2);

		const { context, order } = makeOpen({ answer: false });

		await expect(openStepAsync(context, NO_BUILD)).rejects.toMatchObject({
			code: "declined",
			hint: 'Build it first: run "forge build", or set open.buildFirst.',
			message: `${GAME} does not exist, and it was not built.`,
		});
		expect(order).toStrictEqual([]);
	});
});
