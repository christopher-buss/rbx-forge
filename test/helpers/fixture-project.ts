import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { onTestFinished } from "vitest";

import { makeProject, runBinAsync } from "../e2e/run-bin.ts";
import { createFixtureBinDirectory } from "./fixture-bin.ts";
import { killWorkers, readWorkerLog } from "./worker-log.ts";

const PATH_NAME = /^path$/i;

/** A temporary project for e2e runs of the built bin. */
export interface FixtureProject {
	/**
	 * Run `forge` in the project with the fixture binaries alone on PATH.
	 * The run's variables add to {@link FixtureProjectOptions.variables}.
	 */
	forge: (
		argv: Array<string>,
		variables?: Record<string, string>,
	) => ReturnType<typeof runBinAsync>;
	/** The NDJSON file every fixture process appends a record to. */
	log: string;
	project: string;
}

/** How {@link makeFixtureProject} sets the project up. */
export interface FixtureProjectOptions {
	/** The config file's content; `projectType` defaults to `rbxts`. */
	config?: object;
	/** Extra files, by path relative to the project; folders are created. */
	files?: Record<string, string>;
	/** Put the fixture binaries (fake rojo, hook, launcher) on PATH. */
	fixtureBins?: boolean;
	/** Variables for every run. */
	variables?: Record<string, string>;
}

/**
 * A project with a config file and a Rojo project, and with the fixture
 * binaries alone on PATH. Every fixture process it starts is killed when the
 * test finishes.
 *
 * @param options - Config, extra files, PATH, and variables.
 * @returns The project and a way to run forge in it.
 */
export function makeFixtureProject({
	config = {},
	files = {},
	fixtureBins = true,
	variables = {},
}: FixtureProjectOptions = {}): FixtureProject {
	const project = makeProject();
	writeFiles(project, {
		"default.project.json": JSON.stringify({
			name: "fixture",
			tree: { $className: "DataModel" },
		}),
		"rbx-forge.config.json": JSON.stringify({ projectType: "rbxts", ...config }),
		...files,
	});
	const bin = makeBinDirectory(project, fixtureBins);

	const log = path.join(project, "workers.ndjson");
	onTestFinished(() => {
		killWorkers(readWorkerLog(log));
	});

	return {
		forge: async (argv, extra = {}) => {
			return runBinAsync(
				argv,
				project,
				environmentWith(bin, { FIXTURE_LOG: log, ...variables, ...extra }),
			);
		},
		log,
		project,
	};
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

/**
 * The folder that is PATH for the project's runs.
 *
 * @param project - The folder to create it in.
 * @param fixtureBins - Fill it with the fixture binaries, or leave it empty.
 * @returns The folder.
 */
function makeBinDirectory(project: string, fixtureBins: boolean): string {
	if (fixtureBins) {
		return createFixtureBinDirectory(path.join(project, "fixture-bin"));
	}

	const empty = path.join(project, "empty-bin");
	mkdirSync(empty);
	return empty;
}
