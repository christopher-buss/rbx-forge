import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { MemoryFileSystem } from "../../test/helpers/seams.ts";
import type { ForgeError } from "../errors.ts";
import type { ProcessRunner, ProcessSpec } from "../process/process-runner.ts";
import { OUTPUT_TAIL_LINES } from "../process/process-runner.ts";
import type { ConfigLoader } from "../seams/config-loader.ts";
import { runCompileCommandAsync } from "./compile.ts";
import type { CommandContext, CommandInput } from "./context.ts";

const TOOLS = path.join(PROJECT, "tools");
const LOG = path.join(PROJECT, ".forge", "logs", "compile.log");
const LOG_KEY = ".forge/logs/compile.log";
const HEADER = "--- forge compile 2026-01-01T00:00:00.000Z ---";
const INPUT: CommandInput = { config: {}, flags: {} };
const GREY = "\u001B[90m";
const RESET = "\u001B[0m";

/** What one fake process prints and how it exits. */
interface FakeRun {
	exitCode: null | number;
	output: Array<string>;
}

interface CompileSetup {
	/** The config file's content besides `projectType`. */
	file?: object;
	/** Seed files; the compiler is on PATH unless this replaces it. */
	files?: Record<string, string>;
	projectType?: "luau" | "rbxts";
	/** How each process runs, by label: `rbxtsc` or a hook's command. */
	runs?: Record<string, FakeRun>;
}

interface CompileRun {
	context: CommandContext;
	memory: MemoryFileSystem;
	/** What ran, in order: `rbxtsc` or a hook's command line. */
	order: () => Array<string>;
	specs: Array<ProcessSpec>;
}

/**
 * Recorded roblox-ts 3.0.0 output, in lines as the process runner hands them
 * on: colors kept, carriage returns gone.
 *
 * @param name - The fixture file.
 * @returns Its lines.
 */
function recorded(name: string): Array<string> {
	const file = path.join(import.meta.dirname, "..", "..", "test", "fixtures", "rbxtsc", name);
	return readFileSync(file, "utf8").split(/\r?\n/);
}

function labelOf(spec: ProcessSpec): string {
	return spec.file === "/bin/sh" ? spec.args[1]! : "rbxtsc";
}

function makeCompile({
	file = {},
	files = { "tools/rbxtsc": "" },
	projectType = "rbxts",
	runs = {},
}: CompileSetup = {}): CompileRun {
	const memory = createMemoryFileSystem(files);
	const specs: Array<ProcessSpec> = [];
	const processRunner = vi.fn<ProcessRunner>(async (spec) => {
		specs.push(spec);
		const { exitCode, output } = runs[labelOf(spec)] ?? { exitCode: 0, output: [] };
		for (const line of output) {
			spec.onLine?.(line);
		}

		return {
			durationMs: 3400,
			exitCode,
			outputTail: output.slice(-OUTPUT_TAIL_LINES),
			signal: exitCode === null ? "SIGKILL" : null,
			type: "exited",
		};
	});
	const configLoader = vi.fn<ConfigLoader>().mockResolvedValue({
		path: path.join(PROJECT, "rbx-forge.config.ts"),
		value: { projectType, ...file },
	});

	return {
		context: createCommandContext({
			env: { PATH: TOOLS },
			seams: createTestSeams({ configLoader, fileSystem: memory.fileSystem, processRunner }),
		}),
		memory,
		order: () => specs.map(labelOf),
		specs,
	};
}

describe(runCompileCommandAsync, () => {
	it("should refuse a Luau project without running anything", async () => {
		expect.assertions(2);

		const { context, specs } = makeCompile({ projectType: "luau" });

		await expect(runCompileCommandAsync(context, INPUT)).rejects.toMatchObject({
			code: "command_unavailable",
			hint: "Luau projects have no compile step: run your Luau tools, such as darklua, directly.",
			message:
				'forge compile is for roblox-ts projects; this project has projectType "luau".',
		});
		expect(specs).toStrictEqual([]);
	});

	it("should run the compiler once in the project and report a clean compile", async () => {
		expect.assertions(2);

		const { context, specs } = makeCompile({
			runs: { rbxtsc: { exitCode: 0, output: recorded("success.txt") } },
		});

		await expect(runCompileCommandAsync(context, INPUT)).resolves.toStrictEqual({
			data: { diagnostics: [], durationMs: 3400, errors: 0, hooks: [], log: LOG },
			summary: `Compiled: 0 errors, 0 warnings. Full output: ${LOG}`,
		});
		// The log test below checks what `onLine` does.
		expect(specs).toStrictEqual([
			{
				args: [],
				cwd: PROJECT,
				env: { PATH: TOOLS },
				file: path.join(TOOLS, "rbxtsc"),
				onLine: specs[0]!.onLine,
			},
		]);
	});

	it("should run the configured compiler command with its arguments", async () => {
		expect.assertions(1);

		const { context, specs } = makeCompile({
			file: { rbxts: { args: ["--verbose"], command: "rbxtsc-fork" } },
			files: { "tools/rbxtsc-fork": "" },
		});
		await runCompileCommandAsync(context, INPUT);

		expect(specs[0]).toMatchObject({
			args: ["--verbose"],
			file: path.join(TOOLS, "rbxtsc-fork"),
		});
	});

	it("should write the full output, without colors, to the compile log", async () => {
		expect.assertions(1);

		const { context, memory } = makeCompile({
			files: { [LOG_KEY]: "earlier run\n", "tools/rbxtsc": "" },
			runs: { rbxtsc: { exitCode: 1, output: recorded("project-error.txt") } },
		});
		await runCompileCommandAsync(context, INPUT).catch(() => {});

		expect(memory.files()[LOG_KEY]).toBe(
			[
				"earlier run",
				HEADER,
				"error TS roblox-ts: Non-package projects must have a Rojo project file!",
				"",
				"",
				"",
			].join("\n"),
		);
	});

	it("should fail with every diagnostic and the error count", async () => {
		expect.assertions(1);

		const output = recorded("type-errors.txt");
		const { context } = makeCompile({ runs: { rbxtsc: { exitCode: 1, output } } });

		await expect(runCompileCommandAsync(context, INPUT)).rejects.toMatchObject({
			code: "compile_failed",
			details: {
				diagnostics: [
					expect.objectContaining({
						code: "TS2322",
						file: "src/shared/module.ts",
						line: 1,
					}),
					expect.objectContaining({
						code: "TS2552",
						file: "src/shared/module.ts",
						line: 3,
					}),
					expect.objectContaining({
						code: "TS2322",
						file: "src/shared/other.ts",
						line: 1,
					}),
				],
				errors: 3,
				log: LOG,
				outputTail: output,
			},
			hint: "Fix the errors, then run forge compile again.",
		});
	});

	it("should show only the last output lines, without colors, in the message", async () => {
		expect.assertions(1);

		const output = Array.from({ length: 30 }, (_, index) => `${GREY}line ${index}${RESET}`);
		const { context } = makeCompile({
			runs: {
				rbxtsc: {
					exitCode: 1,
					output: ["src/a.ts:1:1 - error TS1005: ';' expected.", ...output],
				},
			},
		});

		await expect(runCompileCommandAsync(context, INPUT)).rejects.toMatchObject({
			message: [
				"rbxtsc failed with 1 error (exit code 1):",
				...Array.from({ length: 20 }, (_, index) => `  line ${index + 10}`),
				`Full output: ${LOG}`,
			].join("\n"),
		});
	});

	it("should count errors in the message", async () => {
		expect.assertions(1);

		const { context } = makeCompile({
			runs: { rbxtsc: { exitCode: 1, output: recorded("roblox-ts-errors.txt") } },
		});

		await expect(runCompileCommandAsync(context, INPUT)).rejects.toSatisfy(
			(error: ForgeError) => {
				return error.message.startsWith("rbxtsc failed with 2 errors (exit code 1):\n");
			},
		);
	});

	it("should report warnings of a compile that succeeded", async () => {
		expect.assertions(1);

		const { context } = makeCompile({
			runs: {
				rbxtsc: {
					exitCode: 0,
					output: [
						"src/a.ts:2:3 - warning TS roblox-ts: Unused import.",
						"",
						"src/b.ts:4:1 - warning TS roblox-ts: Unused import.",
					],
				},
			},
		});

		await expect(runCompileCommandAsync(context, INPUT)).resolves.toMatchObject({
			data: {
				diagnostics: [
					expect.objectContaining({ file: "src/a.ts", severity: "warning" }),
					expect.objectContaining({ file: "src/b.ts", severity: "warning" }),
				],
				errors: 0,
			},
			summary: `Compiled: 0 errors, 2 warnings. Full output: ${LOG}`,
		});
	});

	it("should count errors a compiler reports while it still exits with code 0", async () => {
		expect.assertions(1);

		const { context } = makeCompile({
			runs: {
				rbxtsc: {
					exitCode: 0,
					output: [
						"src/a.ts:2:3 - warning TS roblox-ts: Unused import.",
						"",
						"src/b.ts:4:1 - error TS2322: Type 'number' is not assignable to type 'string'.",
					],
				},
			},
		});
		const { summary } = await runCompileCommandAsync(context, INPUT);

		expect(summary).toBe(`Compiled: 1 error, 1 warning. Full output: ${LOG}`);
	});

	it("should fail as process_failed when a signal ends the compiler", async () => {
		expect.assertions(1);

		const { context } = makeCompile({ runs: { rbxtsc: { exitCode: null, output: [] } } });

		await expect(runCompileCommandAsync(context, INPUT)).rejects.toMatchObject({
			code: "process_failed",
			message: "rbxtsc failed (exit code null).",
		});
	});

	it("should fail with compiler_missing when the compiler is not installed", async () => {
		expect.assertions(1);

		const { context } = makeCompile({ files: {} });

		await expect(runCompileCommandAsync(context, INPUT)).rejects.toMatchObject({
			code: "compiler_missing",
			hint: "Install roblox-ts in the project (npm install --save-dev roblox-ts), or set rbxts.command.",
			message:
				'The compiler ("rbxtsc") is not installed: it is not a bin of a project dependency or on PATH.',
		});
	});

	it("should run compile hooks around the compiler and return their results", async () => {
		expect.assertions(2);

		const { context, order } = makeCompile({
			file: { hooks: { compile: { post: ["lint"], pre: ["codegen"] } } },
		});
		const { data } = await runCompileCommandAsync(context, INPUT);

		expect(order()).toStrictEqual(["codegen", "rbxtsc", "lint"]);
		expect(data["hooks"]).toStrictEqual([
			expect.objectContaining({ id: "compile:pre:0", outcome: "succeeded" }),
			expect.objectContaining({ id: "compile:post:0", outcome: "succeeded" }),
		]);
	});

	it("should skip post hooks when the compile fails", async () => {
		expect.assertions(2);

		const { context, order } = makeCompile({
			file: { hooks: { compile: { post: ["lint"] } } },
			runs: { rbxtsc: { exitCode: 1, output: recorded("type-errors.txt") } },
		});

		await expect(runCompileCommandAsync(context, INPUT)).rejects.toMatchObject({
			code: "compile_failed",
		});
		expect(order()).toStrictEqual(["rbxtsc"]);
	});
});
