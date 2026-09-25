import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { resolveConfig } from "../config/resolve.ts";
import type { ForgeConfig } from "../config/schema.ts";
import { EXIT_FAILURE } from "../exit-codes.ts";
import type { ProcessOutcome, ProcessRunner, ProcessSpec } from "../process/process-runner.ts";
import { resolveSyncbackTarget, syncbackAsync } from "./syncback.ts";

const TOOLS = path.join(PROJECT, "tools");
const TARGET = { input: "game.rbxl", project: "default.project.json" };

interface SyncbackSetup {
	/** The config file's content besides `projectType`. */
	file?: Partial<ForgeConfig>;
	/** What each spawn returns, by its label (see {@link labelOf}). */
	outcomes?: Record<string, ProcessOutcome>;
}

interface SyncbackRun {
	config: ResolvedConfig;
	context: CommandContext;
	/** What ran, in order. */
	order: () => Array<string>;
	specs: Array<ProcessSpec>;
}

function exited(exitCode: number, outputTail: Array<string> = []): ProcessOutcome {
	return { durationMs: 812, exitCode, outputTail, signal: null, type: "exited" };
}

/**
 * Name a spawn: a hook's command line, `probe` for `rojo syncback --help`, or
 * `rojo` for the syncback itself.
 *
 * @param spec - The spawn.
 * @returns Its label.
 */
function labelOf(spec: ProcessSpec): string {
	if (spec.file === "/bin/sh") {
		return spec.args[1]!;
	}

	return spec.args.includes("--help") ? "probe" : "rojo";
}

function makeSyncback({ file = {}, outcomes = {} }: SyncbackSetup = {}): SyncbackRun {
	const specs: Array<ProcessSpec> = [];
	const processRunner = vi.fn<ProcessRunner>(async (spec) => {
		specs.push(spec);
		return outcomes[labelOf(spec)] ?? exited(0);
	});

	return {
		config: resolveConfig({ projectType: "rbxts", ...file }, {}),
		context: createCommandContext({
			env: { PATH: TOOLS },
			seams: createTestSeams({
				fileSystem: createMemoryFileSystem({ "tools/rojo": "" }).fileSystem,
				processRunner,
			}),
		}),
		order: () => specs.map(labelOf),
		specs,
	};
}

describe(resolveSyncbackTarget, () => {
	it("should read the build output with the Rojo project by default", () => {
		expect.assertions(1);

		const config = resolveConfig(
			{ buildOutputPath: "out/place.rbxl", projectType: "rbxts", rojoProjectPath: "a.json" },
			{},
		);

		expect(resolveSyncbackTarget(config)).toStrictEqual({
			input: "out/place.rbxl",
			project: "a.json",
		});
	});

	it("should prefer the syncback options", () => {
		expect.assertions(1);

		const config = resolveConfig(
			{
				projectType: "luau",
				syncback: { inputPath: "studio.rbxl", projectPath: "sync.project.json" },
			},
			{},
		);

		expect(resolveSyncbackTarget(config)).toStrictEqual({
			input: "studio.rbxl",
			project: "sync.project.json",
		});
	});
});

describe(syncbackAsync, () => {
	it("should check for syncback support, then sync the place into the project", async () => {
		expect.assertions(2);

		const { config, context, specs } = makeSyncback();

		await expect(syncbackAsync(context, config, TARGET)).resolves.toStrictEqual({
			hooks: [],
			value: {
				durationMs: 812,
				input: path.join(PROJECT, "game.rbxl"),
				project: "default.project.json",
			},
		});
		expect(specs.map(({ args }) => args)).toStrictEqual([
			["syncback", "--help"],
			["syncback", "default.project.json", "--input", "game.rbxl", "--non-interactive"],
		]);
	});

	it("should run syncback hooks around Rojo and return their results", async () => {
		expect.assertions(2);

		const { config, context, order } = makeSyncback({
			file: { hooks: { syncback: { post: ["lint --fix"], pre: ["save-check"] } } },
		});
		const { hooks } = await syncbackAsync(context, config, TARGET);

		expect(order()).toStrictEqual(["probe", "save-check", "rojo", "lint --fix"]);
		expect(hooks).toStrictEqual([
			expect.objectContaining({ id: "syncback:pre:0", outcome: "succeeded" }),
			expect.objectContaining({ id: "syncback:post:0", outcome: "succeeded" }),
		]);
	});

	it("should fail before any hook when Rojo has no syncback", async () => {
		expect.assertions(2);

		const { config, context, order } = makeSyncback({
			file: { hooks: { syncback: { pre: ["save-check"] } } },
			outcomes: { probe: exited(2, ["error: unrecognized subcommand 'syncback'"]) },
		});

		await expect(syncbackAsync(context, config, TARGET)).rejects.toMatchObject({
			code: "syncback_unsupported",
		});
		expect(order()).toStrictEqual(["probe"]);
	});

	it("should fail with Rojo's message and skip post hooks when syncback fails", async () => {
		expect.assertions(2);

		const { config, context, order } = makeSyncback({
			file: { hooks: { syncback: { post: ["lint --fix"] } } },
			outcomes: { rojo: exited(1, ["[ERROR] Could not read place file game.rbxl"]) },
		});

		await expect(syncbackAsync(context, config, TARGET)).rejects.toMatchObject({
			code: "process_failed",
			message:
				"rojo syncback failed (exit code 1).\n  [ERROR] Could not read place file game.rbxl",
		});
		expect(order()).toStrictEqual(["probe", "rojo"]);
	});

	it("should exit non-zero when syncback fails", async () => {
		expect.assertions(1);

		const { config, context } = makeSyncback({ outcomes: { rojo: exited(1) } });

		await expect(syncbackAsync(context, config, TARGET)).rejects.toHaveProperty(
			"exitCode",
			EXIT_FAILURE,
		);
	});
});
