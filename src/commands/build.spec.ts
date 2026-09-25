import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { MemoryFileSystem } from "../../test/helpers/seams.ts";
import type { ConfigLayer } from "../config/schema.ts";
import type { ProcessOutcome, ProcessRunner, ProcessSpec } from "../process/process-runner.ts";
import type { ConfigLoader } from "../seams/config-loader.ts";
import { runBuildCommandAsync } from "./build.ts";
import type { CommandContext, CommandInput } from "./context.ts";

const TOOLS = path.join(PROJECT, "tools");
const ROJO = path.join(TOOLS, "rojo");

interface BuildSetup {
	/** The config file's content. */
	file?: object;
	/** Extra files besides the Rojo executable. */
	files?: Record<string, string>;
	/** What each spawn returns, by its first argument (`build` or a hook). */
	outcomes?: Record<string, ProcessOutcome>;
}

interface BuildRun {
	configLoader: ReturnType<typeof vi.fn<ConfigLoader>>;
	context: CommandContext;
	memory: MemoryFileSystem;
	/** What ran, in order: `rojo` or a hook's command line. */
	order: () => Array<string>;
	specs: Array<ProcessSpec>;
}

function exited(exitCode: number, outputTail: Array<string> = []): ProcessOutcome {
	return { durationMs: 1200, exitCode, outputTail, signal: null, type: "exited" };
}

function labelOf(spec: ProcessSpec): string {
	return spec.file === "/bin/sh" ? spec.args[1]! : "rojo";
}

function makeBuild({
	file = {},
	files = { "tools/rojo": "" },
	outcomes = {},
}: BuildSetup = {}): BuildRun {
	const memory = createMemoryFileSystem(files);
	const specs: Array<ProcessSpec> = [];
	const processRunner = vi.fn<ProcessRunner>(async (spec) => {
		specs.push(spec);
		return outcomes[labelOf(spec)] ?? exited(0);
	});
	const configLoader = vi.fn<ConfigLoader>().mockResolvedValue({
		path: path.join(PROJECT, "rbx-forge.config.ts"),
		value: { projectType: "rbxts", ...file },
	});

	return {
		configLoader,
		context: createCommandContext({
			env: { PATH: TOOLS },
			seams: createTestSeams({ configLoader, fileSystem: memory.fileSystem, processRunner }),
		}),
		memory,
		order: () => specs.map(labelOf),
		specs,
	};
}

function input(flags: CommandInput["flags"] = {}, config: ConfigLayer = {}): CommandInput {
	return { config, flags };
}

describe(runBuildCommandAsync, () => {
	it("should build the configured project to the configured output", async () => {
		expect.assertions(2);

		const { context, specs } = makeBuild({
			file: { buildOutputPath: "place.rbxl", rojoProjectPath: "build.project.json" },
		});

		await expect(runBuildCommandAsync(context, input())).resolves.toStrictEqual({
			data: { durationMs: 1200, hooks: [], output: path.join(PROJECT, "place.rbxl") },
			summary: `Built ${path.join(PROJECT, "place.rbxl")}.`,
		});
		expect(specs).toStrictEqual([
			{
				args: ["build", "build.project.json", "--output", "place.rbxl"],
				cwd: PROJECT,
				env: { PATH: TOOLS },
				file: ROJO,
			},
		]);
	});

	it("should build to --output and create its folder", async () => {
		expect.assertions(2);

		const { context, memory, specs } = makeBuild();
		await runBuildCommandAsync(
			context,
			input({ output: "out/game.rbxl" }, { buildOutputPath: "out/game.rbxl" }),
		);

		expect(specs[0]!.args).toStrictEqual([
			"build",
			"default.project.json",
			"--output",
			"out/game.rbxl",
		]);
		expect(memory.files()).toContainKey("out");
	});

	it("should build into the plugins folder with --plugin", async () => {
		expect.assertions(2);

		const { context, specs } = makeBuild();

		await expect(
			runBuildCommandAsync(context, input({ plugin: "Tool.rbxm" })),
		).resolves.toStrictEqual({
			data: { durationMs: 1200, hooks: [], plugin: "Tool.rbxm" },
			summary: "Built plugin Tool.rbxm.",
		});
		expect(specs[0]!.args).toStrictEqual([
			"build",
			"default.project.json",
			"--plugin",
			"Tool.rbxm",
		]);
	});

	it("should refuse --output with --plugin before loading the config", async () => {
		expect.assertions(2);

		const { configLoader, context } = makeBuild();

		await expect(
			runBuildCommandAsync(context, input({ output: "a.rbxl", plugin: "b.rbxm" })),
		).rejects.toMatchObject({
			code: "usage",
			message: "--output and --plugin cannot be used together.",
		});
		expect(configLoader).not.toHaveBeenCalled();
	});

	it("should run the configured Rojo command, as a Node tool when a dependency has it", async () => {
		expect.assertions(1);

		const { context, specs } = makeBuild({
			file: { rojoAlias: "rojo-fork" },
			files: {
				"node_modules/rojo-fork/cli.js": "",
				"node_modules/rojo-fork/package.json": JSON.stringify({
					bin: { "rojo-fork": "cli.js" },
				}),
				"package.json": JSON.stringify({ devDependencies: { "rojo-fork": "1.0.0" } }),
			},
		});
		await runBuildCommandAsync(context, input());

		expect(specs[0]).toMatchObject({
			args: [
				path.join(PROJECT, "node_modules", "rojo-fork", "cli.js"),
				"build",
				"default.project.json",
				"--output",
				"game.rbxl",
			],
			file: "/node",
		});
	});

	it("should fail with rojo_missing when Rojo is not installed", async () => {
		expect.assertions(1);

		const { context } = makeBuild({ files: {} });

		await expect(runBuildCommandAsync(context, input())).rejects.toMatchObject({
			code: "rojo_missing",
			hint: "Install Rojo (https://rojo.space), for example with rokit or mise, or set rojoAlias to its command.",
			message:
				'Rojo ("rojo") is not installed: it is not a bin of a project dependency or on PATH.',
		});
	});

	it("should run build hooks around Rojo and return their results", async () => {
		expect.assertions(2);

		const { context, order } = makeBuild({
			file: { hooks: { build: { post: ["lint"], pre: ["codegen"] } } },
		});
		const { data } = await runBuildCommandAsync(context, input());

		expect(order()).toStrictEqual(["codegen", "rojo", "lint"]);
		expect(data["hooks"]).toStrictEqual([
			expect.objectContaining({ id: "build:pre:0", outcome: "succeeded" }),
			expect.objectContaining({ id: "build:post:0", outcome: "succeeded" }),
		]);
	});

	it("should skip post hooks when Rojo fails", async () => {
		expect.assertions(2);

		const { context, order } = makeBuild({
			file: { hooks: { build: { post: ["lint"] } } },
			outcomes: { rojo: exited(1, ["[ERROR] no such project"]) },
		});

		await expect(runBuildCommandAsync(context, input())).rejects.toMatchObject({
			code: "process_failed",
			message: "rojo build failed (exit code 1).\n  [ERROR] no such project",
		});
		expect(order()).toStrictEqual(["rojo"]);
	});
});
