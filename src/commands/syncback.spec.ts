import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import { configLayerFromFlags } from "../cli/flags.ts";
import type { FlagValues } from "../cli/flags.ts";
import type { ProcessOutcome, ProcessRunner, ProcessSpec } from "../process/process-runner.ts";
import type { ConfigLoader } from "../seams/config-loader.ts";
import type { CommandContext, CommandInput } from "./context.ts";
import { runSyncbackCommandAsync, SYNCBACK_FLAGS } from "./syncback.ts";

const TOOLS = path.join(PROJECT, "tools");

interface SyncbackRun {
	context: CommandContext;
	specs: Array<ProcessSpec>;
}

function exited(exitCode: number, outputTail: Array<string> = []): ProcessOutcome {
	return { durationMs: 812, exitCode, outputTail, signal: null, type: "exited" };
}

function makeSyncback(file: object = {}, rojo: ProcessOutcome = exited(0)): SyncbackRun {
	const specs: Array<ProcessSpec> = [];
	const processRunner = vi.fn<ProcessRunner>(async (spec) => {
		specs.push(spec);
		return spec.args.includes("--help") ? exited(0) : rojo;
	});
	const configLoader = vi.fn<ConfigLoader>().mockResolvedValue({
		path: path.join(PROJECT, "rbx-forge.config.ts"),
		value: { projectType: "rbxts", ...file },
	});

	return {
		context: createCommandContext({
			env: { PATH: TOOLS },
			seams: createTestSeams({
				configLoader,
				fileSystem: createMemoryFileSystem({ "tools/rojo": "" }).fileSystem,
				processRunner,
			}),
		}),
		specs,
	};
}

function input(flags: FlagValues = {}): CommandInput {
	return { config: configLayerFromFlags(SYNCBACK_FLAGS, flags), flags };
}

describe(runSyncbackCommandAsync, () => {
	it("should sync the configured input into the configured project", async () => {
		expect.assertions(2);

		const { context, specs } = makeSyncback({
			buildOutputPath: "build.rbxl",
			syncback: { inputPath: "studio.rbxl", projectPath: "sync.project.json" },
		});

		await expect(runSyncbackCommandAsync(context, input())).resolves.toStrictEqual({
			data: {
				durationMs: 812,
				hooks: [],
				input: path.join(PROJECT, "studio.rbxl"),
				project: "sync.project.json",
			},
			summary: `Synced ${path.join(PROJECT, "studio.rbxl")} into sync.project.json.`,
		});
		expect(specs.at(-1)!.args).toStrictEqual([
			"syncback",
			"sync.project.json",
			"--input",
			"studio.rbxl",
			"--non-interactive",
		]);
	});

	it("should take --input and --project over the config", async () => {
		expect.assertions(1);

		const { context, specs } = makeSyncback({
			syncback: { inputPath: "studio.rbxl", projectPath: "sync.project.json" },
		});
		await runSyncbackCommandAsync(
			context,
			input({ input: "other.rbxl", project: "other.project.json" }),
		);

		expect(specs.at(-1)!.args).toStrictEqual([
			"syncback",
			"other.project.json",
			"--input",
			"other.rbxl",
			"--non-interactive",
		]);
	});

	it("should surface Rojo's error message", async () => {
		expect.assertions(1);

		const { context } = makeSyncback({}, exited(1, ["[ERROR] place file is locked"]));

		await expect(runSyncbackCommandAsync(context, input())).rejects.toMatchObject({
			code: "process_failed",
			message: "rojo syncback failed (exit code 1).\n  [ERROR] place file is locked",
		});
	});
});
