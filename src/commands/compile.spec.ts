import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { MemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { makeStatus, serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { MemoryFileSystem } from "../../test/helpers/seams.ts";
import type { Diagnostic } from "../compiler/diagnostics.ts";
import { ForgeError } from "../errors.ts";
import type { ProcessRunner, ProcessSpec } from "../process/process-runner.ts";
import { OUTPUT_TAIL_LINES } from "../process/process-runner.ts";
import type { ConfigLoader } from "../seams/config-loader.ts";
import { FRESH_BUILD_TIMEOUT_MS } from "../session/build-watch.ts";
import type { LastBuild, ServiceStatus, SessionStatus } from "../session/status.ts";
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
	ipc: MemoryTransport;
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
	const ipc = createMemoryTransport();
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
			seams: createTestSeams({
				configLoader,
				fileSystem: memory.fileSystem,
				ipc,
				processRunner,
			}),
		}),
		ipc,
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
			file: { rbxts: { args: ["--verbose"], command: "rbxtsc-custom" } },
			files: { "tools/rbxtsc-custom": "" },
		});
		await runCompileCommandAsync(context, INPUT);

		expect(specs[0]).toMatchObject({
			args: ["--verbose"],
			file: path.join(TOOLS, "rbxtsc-custom"),
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

	it("should fail with the diagnostics of a one-shot sloptor result", async () => {
		expect.assertions(1);

		const result = {
			diagnostics: [
				{
					code: "TS2322",
					col: 7,
					file: "src/a.ts",
					line: 3,
					message: "Bad.",
					severity: "error",
				},
			],
			durationMs: 142,
			files: 222,
			ok: false,
			version: "1.0.0",
		};
		const { context } = makeCompile({
			runs: { rbxtsc: { exitCode: 1, output: [JSON.stringify(result)] } },
		});

		await expect(runCompileCommandAsync(context, INPUT)).rejects.toMatchObject({
			code: "compile_failed",
			details: {
				diagnostics: [
					{
						code: "TS2322",
						column: 7,
						file: "src/a.ts",
						line: 3,
						message: "Bad.",
						severity: "error",
					},
				],
				errors: 1,
			},
		});
	});

	it("should count a failed sloptor result with no diagnostics as one error, no warnings", async () => {
		expect.assertions(1);

		const result = { diagnostics: [], durationMs: 1, files: 1, ok: false, version: "1" };
		const { context } = makeCompile({
			runs: { rbxtsc: { exitCode: 0, output: [JSON.stringify(result)] } },
		});
		const { summary } = await runCompileCommandAsync(context, INPUT);

		expect(summary).toBe(`Compiled: 1 error, 0 warnings. Full output: ${LOG}`);
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

const SESSION_LOG = path.join(PROJECT, ".forge", "logs", "compiler.log");
const TYPE_ERROR: Diagnostic = {
	code: "TS2322",
	column: 7,
	file: "src/a.ts",
	line: 3,
	message: "Type 'string' is not assignable to type 'number'.\n  More.",
	severity: "error",
};
const WARNING: Diagnostic = {
	code: "roblox-ts",
	column: null,
	file: null,
	line: null,
	message: "Unused import.",
	severity: "warning",
};

function sessionBuild(diagnostics: Array<Diagnostic>): LastBuild {
	return {
		at: "2026-01-01T00:00:02.500Z",
		diagnostics,
		errors: diagnostics.filter(({ severity }) => severity === "error").length,
		startedAt: "2026-01-01T00:00:01.000Z",
	};
}

function compilerStatus(status: ServiceStatus, lastBuild?: LastBuild): SessionStatus {
	const base = makeStatus();
	const compiler = lastBuild === undefined ? {} : { lastBuild };
	return makeStatus({
		services: { ...base.services, compiler: { building: false, status, ...compiler } },
	});
}

describe("runCompileCommandAsync with a running session", () => {
	it("should report the session's fresh build and run no compiler", async () => {
		expect.assertions(3);

		const run = makeCompile();
		const fake = await serveFakeSessionAsync(run.memory, run.ipc, compilerStatus("starting"));
		const waits: Array<unknown> = [];
		fake.freshStatus = (parameters) => {
			waits.push(parameters["timeoutMs"]);
			return { ...compilerStatus("ready", sessionBuild([WARNING])) };
		};

		await expect(runCompileCommandAsync(run.context, INPUT)).resolves.toStrictEqual({
			data: {
				diagnostics: [WARNING],
				durationMs: 1500,
				errors: 0,
				hooks: [],
				log: SESSION_LOG,
				sessionId: "s1",
			},
			summary: `Session s1 built: 0 errors, 1 warning. Full output: ${SESSION_LOG}`,
		});
		expect(waits).toStrictEqual([FRESH_BUILD_TIMEOUT_MS]);
		expect(run.specs).toStrictEqual([]);
	});

	it("should fail with the build's diagnostics when it has errors", async () => {
		expect.assertions(2);

		const run = makeCompile();
		const fake = await serveFakeSessionAsync(run.memory, run.ipc, compilerStatus("ready"));
		fake.freshStatus = () => {
			return { ...compilerStatus("ready", sessionBuild([TYPE_ERROR, WARNING])) };
		};

		await expect(runCompileCommandAsync(run.context, INPUT)).rejects.toMatchObject({
			code: "compile_failed",
			details: {
				diagnostics: [TYPE_ERROR, WARNING],
				errors: 1,
				log: SESSION_LOG,
				sessionId: "s1",
			},
			hint: "Fix the errors, then run forge compile again.",
			message: [
				"The build of session s1 has 1 error:",
				"  src/a.ts:3:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
				`Full output: ${SESSION_LOG}`,
			].join("\n"),
		});
		expect(run.specs).toStrictEqual([]);
	});

	it("should list at most 20 errors in the message", async () => {
		expect.assertions(1);

		const errors = Array.from({ length: 25 }, (_, index) => {
			return { ...TYPE_ERROR, line: index + 1 };
		});
		const run = makeCompile();
		const fake = await serveFakeSessionAsync(run.memory, run.ipc, compilerStatus("ready"));
		fake.freshStatus = () => {
			return { ...compilerStatus("ready", sessionBuild([WARNING, ...errors])) };
		};

		const tail: Array<string> = [
			"  src/a.ts:20:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
			"  ...and 5 more",
			`Full output: ${SESSION_LOG}`,
		];

		await expect(runCompileCommandAsync(run.context, INPUT)).rejects.toThrow(tail.join("\n"));
	});

	it("should name a diagnostic with no location by its code alone", async () => {
		expect.assertions(1);

		const run = makeCompile();
		const fake = await serveFakeSessionAsync(run.memory, run.ipc, compilerStatus("ready"));
		fake.freshStatus = () => {
			return {
				...compilerStatus("ready", sessionBuild([{ ...WARNING, severity: "error" }])),
			};
		};

		await expect(runCompileCommandAsync(run.context, INPUT)).rejects.toMatchObject({
			message: [
				"The build of session s1 has 1 error:",
				"  error roblox-ts: Unused import.",
				`Full output: ${SESSION_LOG}`,
			].join("\n"),
		});
	});

	it.for<ServiceStatus>(["off", "stopped"])(
		"should fail with compiler_off when the session's compiler is %s",
		async (status) => {
			expect.assertions(2);

			const run = makeCompile();
			const fake = await serveFakeSessionAsync(run.memory, run.ipc, compilerStatus(status));
			fake.freshStatus = () => {
				throw new Error("no wait");
			};

			await expect(runCompileCommandAsync(run.context, INPUT)).rejects.toMatchObject({
				code: "compiler_off",
				details: { sessionId: "s1", status },
				hint: 'Run "forge up" to start the compiler, then forge compile again.',
				message: `Session s1 runs, but its compiler is ${status}: no build to report.`,
			});
			expect(run.specs).toStrictEqual([]);
		},
	);

	it("should run compile hooks around the wait", async () => {
		expect.assertions(2);

		const run = makeCompile({
			file: { hooks: { compile: { post: ["lint"], pre: ["codegen"] } } },
		});
		const fake = await serveFakeSessionAsync(run.memory, run.ipc, compilerStatus("ready"));
		fake.freshStatus = () => {
			run.specs.push({ args: ["-c", "wait"], cwd: PROJECT, env: {}, file: "/bin/sh" });
			return { ...compilerStatus("ready", sessionBuild([])) };
		};

		const { data } = await runCompileCommandAsync(run.context, INPUT);

		expect(run.order()).toStrictEqual(["codegen", "wait", "lint"]);
		expect(data["hooks"]).toStrictEqual([
			expect.objectContaining({ id: "compile:pre:0", outcome: "succeeded" }),
			expect.objectContaining({ id: "compile:post:0", outcome: "succeeded" }),
		]);
	});

	it("should pass on a failure of the wait", async () => {
		expect.assertions(2);

		const run = makeCompile();
		const fake = await serveFakeSessionAsync(run.memory, run.ipc, compilerStatus("ready"));
		fake.freshStatus = () => {
			throw new ForgeError("compile_timeout", "No fresh build.");
		};

		await expect(runCompileCommandAsync(run.context, INPUT)).rejects.toMatchObject({
			code: "compile_timeout",
		});
		expect(run.specs).toStrictEqual([]);
	});

	it("should fail, and compile nothing, when the session answers with no status", async () => {
		expect.assertions(2);

		const run = makeCompile();
		const fake = await serveFakeSessionAsync(run.memory, run.ipc);
		fake.answer = { running: "maybe" };

		await expect(runCompileCommandAsync(run.context, INPUT)).rejects.toMatchObject({
			code: "internal_error",
		});
		expect(run.specs).toStrictEqual([]);
	});

	it("should compile once when the named session no longer answers", async () => {
		expect.assertions(1);

		const run = makeCompile();
		const fake = await serveFakeSessionAsync(run.memory, run.ipc, compilerStatus("ready"));
		await fake.stop();
		await runCompileCommandAsync(run.context, INPUT);

		expect(run.order()).toStrictEqual(["rbxtsc"]);
	});
});
