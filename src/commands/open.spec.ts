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
import type { ConfigLayer } from "../config/schema.ts";
import type { ProcessOutcome, ProcessRunner, ProcessSpec } from "../process/process-runner.ts";
import type { ConfigLoader } from "../seams/config-loader.ts";
import type { Prompter } from "../seams/prompter.ts";
import type { StudioLauncher, StudioLaunchOutcome } from "../studio/launcher.ts";
import type { CommandContext, CommandInput } from "./context.ts";
import { runOpenAsync } from "./open.ts";

const TOOLS = path.join(PROJECT, "tools");
const GAME = path.join(PROJECT, "game.rbxl");

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
		return outcomes[labelOf(spec)] ?? exited(0);
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

describe(runOpenAsync, () => {
	it("should build the place first by default, then open it", async () => {
		expect.assertions(3);

		const { context, launcher, order, specs } = makeOpen();

		await expect(runOpenAsync(context, input())).resolves.toStrictEqual({
			data: {
				build: { durationMs: 900, hooks: [], output: GAME },
				hooks: [],
				place: GAME,
				studio: null,
			},
			summary: `Opened ${GAME} in Roblox Studio.`,
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

	it("should open an existing place without building with --no-build", async () => {
		expect.assertions(2);

		const { context, order } = makeOpen({ files: { "game.rbxl": "place" } });

		await expect(runOpenAsync(context, input(NO_BUILD))).resolves.toStrictEqual({
			data: { build: null, hooks: [], place: GAME, studio: null },
			summary: `Opened ${GAME} in Roblox Studio.`,
		});
		expect(order).toStrictEqual(["studio"]);
	});

	it("should start the Studio --studio-path names, and report it", async () => {
		expect.assertions(2);

		const { context, launcher } = makeOpen({
			files: { "game.rbxl": "place" },
			launch: { studio: { pid: 7, startTime: "70" }, type: "launched" },
		});

		await expect(
			runOpenAsync(context, { config: NO_BUILD, flags: { "studio-path": "bin/Studio.exe" } }),
		).resolves.toMatchObject({ data: { studio: { pid: 7, startTime: "70" } } });
		expect(launcher.mock.calls[0]![0].studioPath).toBe(path.join(PROJECT, "bin/Studio.exe"));
	});

	it("should pass on the launcher's hint", async () => {
		expect.assertions(1);

		const { context } = makeOpen({
			files: { "game.rbxl": "place" },
			launch: { hint: "Fix it.", message: "--studio-path names x.", type: "failed" },
		});

		await expect(runOpenAsync(context, input(NO_BUILD))).rejects.toMatchObject({
			hint: "Fix it.",
		});
	});

	it("should skip the build when the config turns buildFirst off", async () => {
		expect.assertions(1);

		const { context, order } = makeOpen({
			file: NO_BUILD,
			files: { "game.rbxl": "place" },
		});
		await runOpenAsync(context, input());

		expect(order).toStrictEqual(["studio"]);
	});

	it("should build with --build even when the config turns buildFirst off", async () => {
		expect.assertions(1);

		const { context, order } = makeOpen({ file: NO_BUILD });
		await runOpenAsync(context, input({ open: { buildFirst: true } }));

		expect(order).toStrictEqual(["rojo", "studio"]);
	});

	it("should build and open the given place from its own project", async () => {
		expect.assertions(2);

		const place = path.join(PROJECT, "places", "test.rbxl");
		const { context, launcher, specs } = makeOpen({
			file: { buildOutputPath: "other.rbxl", open: { projectPath: "test.project.json" } },
		});
		await runOpenAsync(context, input({ open: { buildOutputPath: "places/test.rbxl" } }));

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

		await expect(runOpenAsync(context, input(NO_BUILD))).rejects.toMatchObject({
			code: "place_not_found",
			hint: 'Build it first: run "forge open --build" or "forge build".',
			message: `${GAME} does not exist.`,
		});
		expect(launcher).not.toHaveBeenCalled();
	});

	it("should offer to build a missing place and build it when the user agrees", async () => {
		expect.assertions(2);

		const { confirm, context, order } = makeOpen({ answer: true });
		await runOpenAsync(context, input(NO_BUILD));

		expect(confirm).toHaveBeenCalledExactlyOnceWith(
			`${GAME} does not exist. Build it now?`,
			true,
		);
		expect(order).toStrictEqual(["rojo", "studio"]);
	});

	it("should fail with declined when the user declines the build", async () => {
		expect.assertions(2);

		const { context, order } = makeOpen({ answer: false });

		await expect(runOpenAsync(context, input(NO_BUILD))).rejects.toMatchObject({
			code: "declined",
			hint: 'Build it first: run "forge open --build" or "forge build".',
			message: `${GAME} does not exist, and it was not built.`,
		});
		expect(order).toStrictEqual([]);
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
			files: { "game.rbxl": "place" },
			launch: { message: "xdg-open exited with code 4.", type: "failed" },
		});

		await expect(runOpenAsync(context, input(NO_BUILD))).rejects.toMatchObject({
			code: "studio_launch_failed",
			hint: "Check that Roblox Studio is installed and opens .rbxl files.",
			message: `Could not open ${GAME} in Roblox Studio: xdg-open exited with code 4.`,
		});
		expect(reporter.events).toStrictEqual([
			{ name: "open Roblox Studio", status: "started", type: "step" },
			{ name: "open Roblox Studio", status: "failed", type: "step" },
		]);
	});

	it("should report opening Studio as a step", async () => {
		expect.assertions(1);

		const { context, reporter } = makeOpen({ files: { "game.rbxl": "place" } });
		await runOpenAsync(context, input(NO_BUILD));

		expect(reporter.events).toStrictEqual([
			{ name: "open Roblox Studio", status: "started", type: "step" },
			{ name: "open Roblox Studio", status: "succeeded", type: "step" },
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
