import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

import { EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE } from "../../src/exit-codes.ts";
import { createFixtureBinDirectory } from "../helpers/fixture-bin.ts";
import { parseResult } from "../helpers/output.ts";
import {
	isProcessAlive,
	killWorkers,
	readWorkerLog,
	waitForWorkersAsync,
} from "../helpers/worker-log.ts";
import { BIN, makeProject, runBinAsync } from "./run-bin.ts";

const FAKE_WORKER = path.join(import.meta.dirname, "..", "fixtures", "bin", "fake-worker.ts");
const NODE = `"${process.execPath}"`;
const PATH_NAME = /^path$/i;

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

interface FixtureOptions {
	/** The config file's content besides `projectType`. */
	config?: object;
	/** Extra files, by path relative to the project. */
	files?: Record<string, string>;
	/** Put the fixture binaries (fake rojo, hook) on PATH. */
	fixtureBins?: boolean;
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

function writeFiles(root: string, files: Record<string, string>): void {
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(root, name);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
}

function makeFixture({
	config = {},
	files = {},
	fixtureBins = true,
}: FixtureOptions = {}): Fixture {
	const project = makeProject();
	writeFiles(project, {
		"default.project.json": JSON.stringify({
			name: "fixture",
			tree: { $className: "DataModel" },
		}),
		"rbx-forge.config.json": JSON.stringify({ projectType: "rbxts", ...config }),
		...files,
	});
	const bin = path.join(project, fixtureBins ? "fixture-bin" : "empty-bin");
	if (fixtureBins) {
		createFixtureBinDirectory(bin);
	} else {
		mkdirSync(bin);
	}

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

async function waitForExitAsync(
	pids: ReadonlyArray<number>,
	timeoutMs = 10_000,
): Promise<Array<number>> {
	const deadline = Date.now() + timeoutMs;
	let alive = pids.filter(isProcessAlive);
	while (alive.length > 0 && Date.now() < deadline) {
		await sleep(100);
		alive = alive.filter(isProcessAlive);
	}

	return alive;
}

describe("forge build", () => {
	it("should build the configured output with the Rojo on PATH", async () => {
		expect.assertions(3);

		const { forge, project } = makeFixture();
		const { status, stdout } = await forge(["build", "--json"]);

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseResult(stdout).data).toMatchObject({
			hooks: [],
			output: path.join(project, "game.rbxl"),
		});
		expect(readFileSync(path.join(project, "game.rbxl"), "utf8")).toBe("fake place\n");
	});

	it("should build to --output, creating its folder", async () => {
		expect.assertions(2);

		const { forge, project } = makeFixture();
		const { status } = await forge(["build", "--output", "out/place.rbxl"]);

		expect(status).toBe(EXIT_SUCCESS);
		expect(existsSync(path.join(project, "out", "place.rbxl"))).toBeTrue();
	});

	it("should pass --plugin to Rojo", async () => {
		expect.assertions(2);

		const { forge, log } = makeFixture();
		const { status } = await forge(["build", "--plugin", "Tool.rbxm"]);

		expect(status).toBe(EXIT_SUCCESS);
		expect(readWorkerLog(log).map(({ args }) => args)).toStrictEqual([
			["build", "default.project.json", "--plugin", "Tool.rbxm"],
		]);
	});

	it("should exit 2 for --output with --plugin", async () => {
		expect.assertions(2);

		const { forge } = makeFixture();
		const { status, stdout } = await forge([
			"build",
			"--output",
			"a.rbxl",
			"--plugin",
			"b.rbxm",
		]);

		expect(status).toBe(EXIT_USAGE);
		expect(parseResult(stdout).error!.code).toBe("usage");
	});

	it("should fail with rojo_missing when Rojo is not installed", async () => {
		expect.assertions(2);

		const { forge } = makeFixture({ fixtureBins: false });
		const { status, stdout } = await forge(["build"]);

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout).error).toMatchObject({
			code: "rojo_missing",
			hint: "Install Rojo (https://rojo.space), for example with rokit or mise, or set rojoAlias to its command.",
		});
	});

	it("should run a Node-based Rojo from a dependency with the current Node", async () => {
		expect.assertions(2);

		const { forge, log } = makeFixture({
			files: {
				"node_modules/fake-rojo/cli.mjs": [
					'process.argv.splice(2, 0, "rojo");',
					`await import(${JSON.stringify(pathToFileURL(FAKE_WORKER).href)});`,
					"",
				].join("\n"),
				"node_modules/fake-rojo/package.json": JSON.stringify({
					name: "fake-rojo",
					bin: { rojo: "cli.mjs" },
				}),
				"package.json": JSON.stringify({ devDependencies: { "fake-rojo": "1.0.0" } }),
			},
			fixtureBins: false,
		});
		const { status } = await forge(["build"]);

		expect(status).toBe(EXIT_SUCCESS);
		expect(readWorkerLog(log)).toStrictEqual([
			expect.objectContaining({
				args: ["build", "default.project.json", "--output", "game.rbxl"],
				role: "rojo",
			}),
		]);
	});

	describe("hooks", () => {
		it("should run pre and post hooks around Rojo and report them", async () => {
			expect.assertions(3);

			const { forge, log } = makeFixture({
				config: { hooks: { build: { post: ["hook post"], pre: ["hook pre"] } } },
			});
			const { status, stdout } = await forge(["build", "--json"]);

			expect(status).toBe(EXIT_SUCCESS);
			expect(readWorkerLog(log).map(({ args, role }) => ({ args, role }))).toStrictEqual([
				{ args: ["pre"], role: "hook" },
				{ args: ["build", "default.project.json", "--output", "game.rbxl"], role: "rojo" },
				{ args: ["post"], role: "hook" },
			]);
			expect(parseResult(stdout).data!["hooks"]).toStrictEqual([
				expect.objectContaining({
					id: "build:pre:0",
					exitCode: 0,
					ok: true,
					outcome: "succeeded",
				}),
				expect.objectContaining({
					id: "build:post:0",
					exitCode: 0,
					ok: true,
					outcome: "succeeded",
				}),
			]);
		});

		it("should abort the build when a pre hook fails", async () => {
			expect.assertions(4);

			const { forge, log, project } = makeFixture({
				config: { hooks: { build: { post: ["hook post"], pre: ["hook pre"] } } },
			});
			const { status, stdout } = await forge(["build", "--json"], { FIXTURE_EXIT_CODE: "3" });

			expect(status).toBe(EXIT_FAILURE);
			expect(parseResult(stdout).error).toMatchObject({
				code: "hook_failed",
				details: { hooks: [expect.objectContaining({ id: "build:pre:0", exitCode: 3 })] },
			});
			expect(readWorkerLog(log).map(({ role }) => role)).toStrictEqual(["hook"]);
			expect(existsSync(path.join(project, "game.rbxl"))).toBeFalse();
		});

		it("should run a post hook that calls forge build only once", async () => {
			expect.assertions(3);

			const { forge, log } = makeFixture({
				config: { hooks: { build: { post: [`${NODE} "${BIN}" build --json`] } } },
			});
			const { status, stdout } = await forge(["build", "--json"]);

			expect(status).toBe(EXIT_SUCCESS);
			// The outer build and the build inside the hook; the inner build
			// skipped the hook, so there is no third.
			expect(readWorkerLog(log).map(({ role }) => role)).toStrictEqual(["rojo", "rojo"]);
			// The inner build's NDJSON is the hook's output.
			expect(JSON.stringify(parseResult(stdout).data)).toContain(
				"Skipped hook build:post:0 (",
			);
		});

		it("should fail a hook nested deeper than 8", async () => {
			expect.assertions(3);

			const { forge, log } = makeFixture({
				config: { hooks: { build: { pre: ["hook pre"] } } },
			});
			const stack = Array.from({ length: 8 }, (_, index) => `open:pre:${index}`).join(",");
			const { status, stdout } = await forge(["build", "--json"], {
				RBX_FORGE_HOOK_STACK: stack,
			});

			expect(status).toBe(EXIT_FAILURE);
			expect(parseResult(stdout).error!.code).toBe("hook_depth_exceeded");
			expect(readWorkerLog(log)).toStrictEqual([]);
		});

		it("should kill a hook's whole process tree when it times out", async () => {
			expect.assertions(3);

			const { forge, log } = makeFixture({
				config: { hooks: { build: { pre: ["hook hang"] } }, hookTimeoutMs: 2000 },
			});
			const { status, stdout } = await forge(["build", "--json"], {
				FIXTURE_GRANDCHILDREN: "2",
				FIXTURE_HANG: "1",
			});
			const records = await waitForWorkersAsync(log, 3);

			expect(status).toBe(EXIT_FAILURE);
			expect(parseResult(stdout).error).toMatchObject({
				code: "hook_failed",
				details: { hooks: [expect.objectContaining({ outcome: "timed_out" })] },
			});
			await expect(waitForExitAsync(records.map(({ pid }) => pid))).resolves.toStrictEqual(
				[],
			);
		});
	});
});
