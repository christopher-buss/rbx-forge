import path from "node:path";
import { describe, expect, it } from "vitest";

import { EXIT_FAILURE, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import type { FixtureProject } from "../helpers/fixture-project.ts";
import { makeFixtureProject } from "../helpers/fixture-project.ts";
import { parseResult } from "../helpers/output.ts";
import { readWorkerLog } from "../helpers/worker-log.ts";

const PROBE = { args: ["syncback", "--help"], role: "rojo" };
const NO_SYNCBACK =
	"Install Rojo 7.7 or later (https://rojo.space), or set rojoAlias to its command.";

/**
 * A Luau project with a place file, with fake rojo and hook binaries on PATH.
 *
 * @param config - The config file's content besides `projectType`.
 * @returns The project and a way to run forge in it.
 */
function makeFixture(config?: object): FixtureProject {
	return makeFixtureProject({
		config: { projectType: "luau", ...config },
		files: { "game.rbxl": "fake place\n" },
	});
}

function ran(log: string): Array<{ args: Array<string>; role: string }> {
	return readWorkerLog(log).map(({ args, role }) => ({ args, role }));
}

function rojoSyncback(project: string, input: string): { args: Array<string>; role: string } {
	return { args: ["syncback", project, "--input", input, "--non-interactive"], role: "rojo" };
}

describe("forge syncback", () => {
	it("should sync the configured input into the configured project", async () => {
		expect.assertions(3);

		const { forge, log, project } = makeFixture({
			syncback: { inputPath: "studio.rbxl", projectPath: "sync.project.json" },
		});
		const { status, stdout } = await forge(["syncback", "--json"]);

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseResult(stdout).data).toMatchObject({
			hooks: [],
			input: path.join(project, "studio.rbxl"),
			project: "sync.project.json",
		});
		expect(ran(log)).toStrictEqual([PROBE, rojoSyncback("sync.project.json", "studio.rbxl")]);
	});

	it("should take --input and --project over the config", async () => {
		expect.assertions(2);

		const { forge, log } = makeFixture();
		const { status } = await forge([
			"syncback",
			"--input",
			"out/place.rbxl",
			"--project",
			"other.project.json",
		]);

		expect(status).toBe(EXIT_SUCCESS);
		expect(ran(log).at(-1)).toStrictEqual(rojoSyncback("other.project.json", "out/place.rbxl"));
	});

	it("should report syncback_unsupported when Rojo has no syncback, before any hook runs", async () => {
		expect.assertions(3);

		const { forge, log } = makeFixture({ hooks: { syncback: { pre: ["hook pre"] } } });
		const { status, stdout } = await forge(["syncback", "--json"], {
			FIXTURE_ROJO_NO_SYNCBACK: "1",
		});

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout).error).toMatchObject({
			code: "syncback_unsupported",
			hint: NO_SYNCBACK,
			message: 'Rojo ("rojo") has no syncback command. Syncback needs Rojo 7.7 or later.',
		});
		expect(ran(log)).toStrictEqual([PROBE]);
	});

	it("should report Rojo's error and exit non-zero, skipping post hooks", async () => {
		expect.assertions(3);

		const { forge, log } = makeFixture({ hooks: { syncback: { post: ["hook post"] } } });
		const { status, stdout } = await forge(["syncback", "--json"], {
			FIXTURE_ROJO_ERROR: "[ERROR] The place file game.rbxl is not valid",
		});

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout).error).toMatchObject({
			code: "process_failed",
			message:
				"rojo syncback failed (exit code 1).\n  [ERROR] The place file game.rbxl is not valid",
		});
		expect(readWorkerLog(log).map(({ role }) => role)).toStrictEqual(["rojo", "rojo"]);
	});

	it("should run pre and post hooks around Rojo and report them", async () => {
		expect.assertions(3);

		const { forge, log } = makeFixture({
			hooks: { syncback: { post: ["hook post"], pre: ["hook pre"] } },
		});
		const { status, stdout } = await forge(["syncback", "--json"]);

		expect(status).toBe(EXIT_SUCCESS);
		expect(ran(log)).toStrictEqual([
			PROBE,
			{ args: ["pre"], role: "hook" },
			rojoSyncback("default.project.json", "game.rbxl"),
			{ args: ["post"], role: "hook" },
		]);
		expect(parseResult(stdout).data!["hooks"]).toStrictEqual([
			expect.objectContaining({ id: "syncback:pre:0", ok: true, outcome: "succeeded" }),
			expect.objectContaining({ id: "syncback:post:0", ok: true, outcome: "succeeded" }),
		]);
	});

	it("should fail the syncback when a pre hook fails", async () => {
		expect.assertions(3);

		const { forge, log } = makeFixture({ hooks: { syncback: { pre: ["hook pre"] } } });
		const { status, stdout } = await forge(["syncback", "--json"], { FIXTURE_EXIT_CODE: "3" });

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout).error).toMatchObject({
			code: "hook_failed",
			details: { hooks: [expect.objectContaining({ id: "syncback:pre:0", exitCode: 3 })] },
		});
		expect(ran(log)).toStrictEqual([PROBE, { args: ["pre"], role: "hook" }]);
	});
});
