import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import {
	createCommandContext,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { RecordingReporter } from "../../test/helpers/seams.ts";
import type { CommandContext } from "../commands/context.ts";
import { ForgeError } from "../errors.ts";
import type { ProcessOutcome, ProcessRunner, ProcessSpec } from "../process/process-runner.ts";
import type { Environment } from "../seams/seams.ts";
import type { HookConfig, HookResult } from "./run-hooks.ts";
import { runWithHooksAsync } from "./run-hooks.ts";

interface HookRun {
	context: CommandContext;
	reporter: RecordingReporter;
	/** Every process spawned, in order. */
	specs: Array<ProcessSpec>;
	/** The order hooks and the step ran in, by command line or `step`. */
	trail: Array<string>;
}

interface HookRunOptions {
	environment?: Environment;
	/** Outcome per shell command line; missing lines exit 0. */
	outcomes?: Record<string, ProcessOutcome>;
	platform?: NodeJS.Platform;
}

const LOCAL_BIN = path.join(PROJECT, "node_modules", ".bin");

function exited(exitCode: null | number, outputTail: Array<string> = []): ProcessOutcome {
	return { durationMs: 40, exitCode, outputTail, signal: null, type: "exited" };
}

function config(hooks: HookConfig["hooks"]): HookConfig {
	return { hooks, hookTimeoutMs: 5000 };
}

/**
 * The command line of a spawned hook, whichever shell runs it.
 *
 * @param spec - The spawned process.
 * @returns The line the user wrote in the config.
 */
function lineOf(spec: ProcessSpec): string {
	const line = spec.args.at(-1)!;
	return spec.verbatimArguments === true ? line.slice(1, -1) : line;
}

function makeHookRun({
	environment = { PATH: "/usr/bin" },
	outcomes = {},
	platform = "linux",
}: HookRunOptions = {}): HookRun {
	const specs: Array<ProcessSpec> = [];
	const trail: Array<string> = [];
	const reporter = createRecordingReporter();
	const processRunner = vi.fn<ProcessRunner>(async (spec) => {
		specs.push(spec);
		const line = lineOf(spec);
		trail.push(line);
		return outcomes[line] ?? exited(0);
	});
	const defaults = createTestSeams();

	return {
		context: createCommandContext({
			env: environment,
			reporter,
			seams: { ...defaults, host: { ...defaults.host, platform }, processRunner },
		}),
		reporter,
		specs,
		trail,
	};
}

async function failureOfAsync(promise: Promise<unknown>): Promise<ForgeError> {
	try {
		await promise;
	} catch (err) {
		assert(err instanceof ForgeError, "expected a ForgeError");
		return err;
	}

	assert.fail("expected a ForgeError, but the run succeeded");
}

function step(trail: Array<string>, value = "built"): () => Promise<string> {
	return async () => {
		trail.push("step");
		return value;
	};
}

describe(runWithHooksAsync, () => {
	it("should run the step alone when the command has no hooks", async () => {
		expect.assertions(1);

		const { context, trail } = makeHookRun();

		await expect(
			runWithHooksAsync(context, config({ compile: { pre: ["x"] } }), "build", step(trail)),
		).resolves.toStrictEqual({ hooks: [], value: "built" });
	});

	it("should run pre hooks, then the step, then post hooks, each in order", async () => {
		expect.assertions(1);

		const { context, trail } = makeHookRun();
		await runWithHooksAsync(
			context,
			config({ build: { post: ["post 1", "post 2"], pre: ["pre 1", "pre 2"] } }),
			"build",
			step(trail),
		);

		expect(trail).toStrictEqual(["pre 1", "pre 2", "step", "post 1", "post 2"]);
	});

	it("should run a phase that has no list as empty", async () => {
		expect.assertions(1);

		const { context, trail } = makeHookRun();
		await runWithHooksAsync(
			context,
			config({ build: { post: ["lint"] } }),
			"build",
			step(trail),
		);

		expect(trail).toStrictEqual(["step", "lint"]);
	});

	it("should return every hook result with the step's value", async () => {
		expect.assertions(1);

		const { context, trail } = makeHookRun({
			outcomes: { lint: exited(0, ["All clean."]) },
		});

		await expect(
			runWithHooksAsync(
				context,
				config({ build: { post: ["lint"], pre: ["codegen"] } }),
				"build",
				step(trail),
			),
		).resolves.toStrictEqual({
			hooks: [
				{
					id: "build:pre:0",
					command: "codegen",
					durationMs: 40,
					exitCode: 0,
					ok: true,
					outcome: "succeeded",
					outputTail: [],
				},
				{
					id: "build:post:0",
					command: "lint",
					durationMs: 40,
					exitCode: 0,
					ok: true,
					outcome: "succeeded",
					outputTail: ["All clean."],
				},
			],
			value: "built",
		});
	});

	it("should run a hook through /bin/sh in the project, with local bins and its identity", async () => {
		expect.assertions(1);

		const { context, specs, trail } = makeHookRun({
			environment: { HOME: "/home/me", PATH: "/usr/bin" },
		});
		await runWithHooksAsync(
			context,
			config({ build: { pre: ["codegen"] } }),
			"build",
			step(trail),
		);

		expect(specs).toStrictEqual([
			{
				args: ["-c", "codegen"],
				cwd: PROJECT,
				env: {
					HOME: "/home/me",
					PATH: `${LOCAL_BIN}:/usr/bin`,
					RBX_FORGE_HOOK_STACK: "build:pre:0",
				},
				file: "/bin/sh",
				timeoutMs: 5000,
			},
		]);
	});

	it("should run a Windows hook through cmd.exe, keeping the case of Path", async () => {
		expect.assertions(1);

		const { context, specs, trail } = makeHookRun({
			environment: { ComSpec: "C:\\cmd.exe", Path: "C:\\bin" },
			platform: "win32",
		});
		await runWithHooksAsync(
			context,
			config({ build: { pre: ["codegen"] } }),
			"build",
			step(trail),
		);

		expect(specs[0]).toMatchObject({
			args: ["/d", "/s", "/c", '"codegen"'],
			env: { Path: `${LOCAL_BIN};C:\\bin`, RBX_FORGE_HOOK_STACK: "build:pre:0" },
			file: "C:\\cmd.exe",
			verbatimArguments: true,
		});
	});

	it("should report each hook as a step", async () => {
		expect.assertions(1);

		const { context, reporter, trail } = makeHookRun({ outcomes: { lint: exited(1) } });
		const run = runWithHooksAsync(
			context,
			config({ build: { post: ["lint"], pre: ["codegen"] } }),
			"build",
			step(trail),
		);
		await failureOfAsync(run);

		expect(reporter.events).toStrictEqual([
			{ name: "hook build:pre:0: codegen", status: "started", type: "step" },
			{ name: "hook build:pre:0: codegen", status: "succeeded", type: "step" },
			{ name: "hook build:post:0: lint", status: "started", type: "step" },
			{ name: "hook build:post:0: lint", status: "failed", type: "step" },
		]);
	});

	describe("when a pre hook fails", () => {
		it("should abort before later hooks and the step", async () => {
			expect.assertions(1);

			const { context, trail } = makeHookRun({ outcomes: { "pre 1": exited(2) } });
			await failureOfAsync(
				runWithHooksAsync(
					context,
					config({ build: { post: ["post"], pre: ["pre 1", "pre 2"] } }),
					"build",
					step(trail),
				),
			);

			expect(trail).toStrictEqual(["pre 1"]);
		});

		it("should fail with hook_failed, the output tail, and the results", async () => {
			expect.assertions(3);

			const output = Array.from({ length: 12 }, (_, index) => `line ${index}`);
			const { context, trail } = makeHookRun({ outcomes: { codegen: exited(2, output) } });
			const error = await failureOfAsync(
				runWithHooksAsync(
					context,
					config({ build: { pre: ["codegen"] } }),
					"build",
					step(trail),
				),
			);

			expect(error.code).toBe("hook_failed");
			expect(error.message).toBe(
				[
					"Hook build:pre:0 failed (exit code 2): codegen",
					...output.slice(2).map((line) => `  ${line}`),
				].join("\n"),
			);
			expect(error.details).toStrictEqual({
				hooks: [
					{
						id: "build:pre:0",
						command: "codegen",
						durationMs: 40,
						exitCode: 2,
						ok: false,
						outcome: "failed",
						outputTail: output,
					},
				],
			});
		});
	});

	it("should not run post hooks when the step fails", async () => {
		expect.assertions(2);

		const { context, trail } = makeHookRun();
		const failing = new ForgeError("process_failed", "rojo failed");

		await expect(
			runWithHooksAsync(context, config({ build: { post: ["lint"] } }), "build", async () => {
				throw failing;
			}),
		).rejects.toBe(failing);
		expect(trail).toStrictEqual([]);
	});

	it("should fail after the step when a post hook fails, keeping earlier results", async () => {
		expect.assertions(2);

		const { context, trail } = makeHookRun({ outcomes: { lint: exited(1) } });
		const error = await failureOfAsync(
			runWithHooksAsync(
				context,
				config({ build: { post: ["lint"], pre: ["codegen"] } }),
				"build",
				step(trail),
			),
		);

		expect(trail).toStrictEqual(["codegen", "step", "lint"]);
		expect(error.details!["hooks"]).toStrictEqual([
			expect.objectContaining({ id: "build:pre:0", ok: true }),
			expect.objectContaining({ id: "build:post:0", ok: false }),
		]);
	});

	it("should fail a hook that a signal ended", async () => {
		expect.assertions(1);

		const { context, trail } = makeHookRun({ outcomes: { lint: exited(null) } });
		const error = await failureOfAsync(
			runWithHooksAsync(context, config({ build: { post: ["lint"] } }), "build", step(trail)),
		);

		expect(error.message).toBe("Hook build:post:0 failed (exit code null): lint");
	});

	it("should fail a hook that timed out, as killed", async () => {
		expect.assertions(2);

		const { context, trail } = makeHookRun({
			outcomes: { serve: { durationMs: 5000, outputTail: ["waiting"], type: "timed_out" } },
		});
		const error = await failureOfAsync(
			runWithHooksAsync(
				context,
				config({ build: { post: ["serve"] } }),
				"build",
				step(trail),
			),
		);

		expect(error.message).toBe(
			"Hook build:post:0 timed out after 5000 ms and was killed: serve\n  waiting",
		);
		expect(error.details!["hooks"]).toStrictEqual([
			{
				id: "build:post:0",
				command: "serve",
				durationMs: 5000,
				exitCode: null,
				ok: false,
				outcome: "timed_out",
				outputTail: ["waiting"],
			},
		]);
	});

	it("should fail a hook whose shell could not start", async () => {
		expect.assertions(1);

		const { context, trail } = makeHookRun({
			outcomes: {
				lint: {
					errorCode: "ENOENT",
					message: "spawn /bin/sh ENOENT",
					type: "spawn_failed",
				},
			},
		});
		const error = await failureOfAsync(
			runWithHooksAsync(context, config({ build: { pre: ["lint"] } }), "build", step(trail)),
		);

		expect(error.details!["hooks"]).toStrictEqual([
			expect.objectContaining({
				durationMs: 0,
				exitCode: null,
				outcome: "failed",
				outputTail: ["spawn /bin/sh ENOENT"],
			}),
		]);
	});

	describe("cycle guard", () => {
		it("should skip a hook that is already running above this run", async () => {
			expect.assertions(2);

			const { context, reporter, trail } = makeHookRun({
				environment: { RBX_FORGE_HOOK_STACK: "build:post:0" },
			});

			await expect(
				runWithHooksAsync(
					context,
					config({ build: { post: ["forge build"] } }),
					"build",
					step(trail),
				),
			).resolves.toStrictEqual({
				hooks: [
					{
						id: "build:post:0",
						command: "forge build",
						durationMs: 0,
						exitCode: null,
						ok: true,
						outcome: "skipped",
						outputTail: [],
					} satisfies HookResult,
				],
				value: "built",
			});
			expect(reporter.events).toStrictEqual([
				{
					message:
						"Skipped hook build:post:0 (forge build): it is already running above this forge run.",
					type: "warning",
				},
			]);
		});

		it("should pass the inherited stack on with the hook added", async () => {
			expect.assertions(1);

			const { context, specs, trail } = makeHookRun({
				environment: { RBX_FORGE_HOOK_STACK: "open:pre:0" },
			});
			await runWithHooksAsync(
				context,
				config({ build: { post: ["lint"] } }),
				"build",
				step(trail),
			);

			expect(specs[0]!.env["RBX_FORGE_HOOK_STACK"]).toBe("open:pre:0,build:post:0");
		});

		it("should run a hook eight deep", async () => {
			expect.assertions(1);

			const stack = Array.from({ length: 7 }, (_, index) => `open:pre:${index}`).join(",");
			const { context, trail } = makeHookRun({
				environment: { RBX_FORGE_HOOK_STACK: stack },
			});
			await runWithHooksAsync(
				context,
				config({ build: { pre: ["lint"] } }),
				"build",
				step(trail),
			);

			expect(trail).toStrictEqual(["lint", "step"]);
		});

		it("should fail a hook nine deep before it or the step runs", async () => {
			expect.assertions(4);

			const inherited = Array.from({ length: 8 }, (_, index) => `open:pre:${index}`);
			const { context, trail } = makeHookRun({
				environment: { RBX_FORGE_HOOK_STACK: inherited.join(",") },
			});
			const error = await failureOfAsync(
				runWithHooksAsync(
					context,
					config({ build: { pre: ["lint"] } }),
					"build",
					step(trail),
				),
			);

			expect(error.code).toBe("hook_depth_exceeded");
			expect(error.message).toBe("Hook build:pre:0 would nest 9 hooks deep; the limit is 8.");
			expect(error.details).toStrictEqual({
				hooks: [],
				stack: [...inherited, "build:pre:0"],
			});
			expect(trail).toStrictEqual([]);
		});
	});
});
