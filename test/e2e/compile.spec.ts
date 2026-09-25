import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { EXIT_FAILURE, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import type { FixtureProject } from "../helpers/fixture-project.ts";
import { makeFixtureProject } from "../helpers/fixture-project.ts";
import { parseLines, parseResult } from "../helpers/output.ts";
import { readWorkerLog } from "../helpers/worker-log.ts";

/** Output of roblox-ts 3.0.0, recorded on Windows. */
const RECORDED = path.join(import.meta.dirname, "..", "fixtures", "rbxtsc");
const ESCAPE = "\u001B";

function makeFixture(config: Record<string, unknown> = {}): FixtureProject {
	return makeFixtureProject({ config: { projectType: "rbxts", ...config } });
}

function compilerOutput(name: string): Record<string, string> {
	return { FIXTURE_COMPILER_OUTPUT: path.join(RECORDED, name) };
}

function roles(log: string): Array<string> {
	return readWorkerLog(log).map(({ role }) => role);
}

describe("forge compile", () => {
	it("should compile once and write the full output to the compile log", async () => {
		expect.assertions(3);

		const { forge, project } = makeFixture();
		const { status, stdout } = await forge(["compile"], compilerOutput("success.txt"));
		const log = path.join(project, ".forge", "logs", "compile.log");

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseResult(stdout).data).toMatchObject({
			diagnostics: [],
			errors: 0,
			hooks: [],
			log,
		});
		expect(readFileSync(log, "utf8")).toContain("compiling as game..\n");
	});

	it("should fail with structured diagnostics and the error count", async () => {
		expect.assertions(3);

		const { forge } = makeFixture();
		const { status, stdout } = await forge(["compile", "--json"], {
			...compilerOutput("type-errors.txt"),
			FIXTURE_EXIT_CODE: "1",
		});
		const { error } = parseResult(stdout);

		expect(status).toBe(EXIT_FAILURE);
		expect(error).toMatchObject({
			code: "compile_failed",
			details: {
				diagnostics: [
					{
						code: "TS2322",
						column: 7,
						file: "src/shared/module.ts",
						line: 1,
						message: "Type 'string' is not assignable to type 'number'.",
						severity: "error",
					},
					expect.objectContaining({ code: "TS2552", line: 3 }),
					expect.objectContaining({ code: "TS2322", file: "src/shared/other.ts" }),
				],
				errors: 3,
			},
		});
		expect(error!.message).toStartWith("rbxtsc failed with 3 errors (exit code 1):\n");
	});

	it("should keep the compiler's output out of NDJSON and colors out of the log", async () => {
		expect.assertions(2);

		const { forge, project } = makeFixture();
		const { stdout } = await forge(["compile", "--json"], {
			...compilerOutput("roblox-ts-errors.txt"),
			FIXTURE_EXIT_CODE: "1",
		});

		expect(parseLines(stdout)).toStrictEqual([
			{ name: "rbxtsc", status: "started", type: "step" },
			{ name: "rbxtsc", status: "failed", type: "step" },
			expect.objectContaining({ type: "result" }),
		]);
		expect(
			readFileSync(path.join(project, ".forge", "logs", "compile.log"), "utf8"),
		).not.toContain(ESCAPE);
	});

	it("should be unavailable for a Luau project", async () => {
		expect.assertions(3);

		const { forge, log } = makeFixture({ projectType: "luau" });
		const { status, stdout } = await forge(["compile"]);

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout).error).toMatchObject({
			code: "command_unavailable",
			message:
				'forge compile is for roblox-ts projects; this project has projectType "luau".',
		});
		expect(roles(log)).toStrictEqual([]);
	});

	it("should fail with compiler_missing when the compiler is not installed", async () => {
		expect.assertions(2);

		const { forge } = makeFixtureProject({
			config: { projectType: "rbxts" },
			fixtureBins: false,
		});
		const { status, stdout } = await forge(["compile"]);

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout).error!.code).toBe("compiler_missing");
	});

	it("should run compile hooks around the compiler", async () => {
		expect.assertions(2);

		const { forge, log } = makeFixture({
			hooks: { compile: { post: ["hook post"], pre: ["hook pre"] } },
		});
		const { status } = await forge(["compile"]);

		expect(status).toBe(EXIT_SUCCESS);
		expect(roles(log)).toStrictEqual(["hook", "rbxtsc", "hook"]);
	});
});
