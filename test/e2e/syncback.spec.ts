import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished } from "vitest";

import { EXIT_FAILURE, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import { createFixtureBinDirectory } from "../helpers/fixture-bin.ts";
import { parseResult } from "../helpers/output.ts";
import { killWorkers, readWorkerLog } from "../helpers/worker-log.ts";
import { makeProject, runBinAsync } from "./run-bin.ts";

const PATH_NAME = /^path$/i;
const PROBE = { args: ["syncback", "--help"], role: "rojo" };
const NO_SYNCBACK =
	"Install the UpliftGames Rojo fork (https://github.com/UpliftGames/rojo/releases), and set rojoAlias to its command if it is not rojo.";

interface Fixture {
	/** Run `forge` in the project with the fixture binaries first on PATH. */
	forge: (
		argv: Array<string>,
		variables?: Record<string, string>,
	) => ReturnType<typeof runBinAsync>;
	/** The NDJSON file every fixture process appends a record to. */
	log: string;
	project: string;
}

/**
 * This process's environment with PATH replaced. Windows spells the name
 * `Path`, and two spellings of one variable would both reach the child.
 *
 * @param directory - The only PATH entry.
 * @param variables - Variables to add.
 * @returns The environment for a run.
 */
function environmentWith(directory: string, variables: Record<string, string>): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		CI: undefined,
		RBX_FORGE_HOOK_STACK: undefined,
	};
	for (const key of Object.keys(environment)) {
		if (PATH_NAME.test(key)) {
			delete environment[key];
		}
	}

	return { ...environment, ...variables, PATH: directory };
}

/**
 * A project with a config, a Rojo project, and a place file, with fake rojo
 * and hook binaries on PATH.
 *
 * @param config - The config file's content besides `projectType`.
 * @returns The project and a way to run forge in it.
 */
function makeFixture(config: object = {}): Fixture {
	const project = makeProject();
	const files: Record<string, string> = {
		"default.project.json": JSON.stringify({ name: "fixture", tree: {} }),
		"game.rbxl": "fake place\n",
		"rbx-forge.config.json": JSON.stringify({ projectType: "luau", ...config }),
	};
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(path.join(project, name), content);
	}

	const bin = createFixtureBinDirectory(path.join(project, "fixture-bin"));
	const log = path.join(project, "workers.ndjson");
	onTestFinished(() => {
		killWorkers(readWorkerLog(log));
	});

	return {
		forge: async (argv, variables = {}) => {
			return runBinAsync(
				argv,
				project,
				environmentWith(bin, { FIXTURE_LOG: log, ...variables }),
			);
		},
		log,
		project,
	};
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

	it("should name the fork when Rojo has no syncback, before any hook runs", async () => {
		expect.assertions(3);

		const { forge, log } = makeFixture({ hooks: { syncback: { pre: ["hook pre"] } } });
		const { status, stdout } = await forge(["syncback", "--json"], {
			FIXTURE_ROJO_NO_SYNCBACK: "1",
		});

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout).error).toMatchObject({
			code: "syncback_unsupported",
			hint: NO_SYNCBACK,
			message:
				'Rojo ("rojo") has no syncback command. Syncback needs the UpliftGames Rojo fork.',
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
