import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { onTestFinished } from "vitest";

import type { BinRun } from "../e2e/run-bin.ts";
import { makeProject, runBinAsync } from "../e2e/run-bin.ts";
import { createFixtureBinDirectory } from "./fixture-bin.ts";
import { killWorkers, readWorkerLog } from "./worker-log.ts";

const PATH_NAME = /^path$/i;

/** A temporary project for one e2e test. */
export interface FixtureProject {
	/** Run `forge` in the project with the fixture binaries alone on PATH. */
	forge: (argv: Array<string>, variables?: Record<string, string>) => Promise<BinRun>;
	/** The NDJSON file every fixture process appends a record to. */
	log: string;
	project: string;
}

/** What a {@link FixtureProject} holds. */
export interface FixtureProjectOptions {
	/** The config file's content, `projectType` included. */
	config: Record<string, unknown>;
	/** Extra files, by path relative to the project. */
	files?: Record<string, string>;
	/** Put the fixture binaries (fake rojo, compiler, hook) on PATH. */
	fixtureBins?: boolean;
}

/**
 * A project with a JSON config file and a place Rojo project, and the fixture
 * binaries (or an empty folder) as the only PATH entry. Every fixture process
 * still alive when the test finishes is killed.
 *
 * @param options - The config and extra files.
 * @returns The project and a way to run forge in it.
 */
export function makeFixtureProject({
	config,
	files = {},
	fixtureBins = true,
}: FixtureProjectOptions): FixtureProject {
	const project = makeProject();
	writeFiles(project, {
		"default.project.json": JSON.stringify({
			name: "fixture",
			tree: { $className: "DataModel" },
		}),
		"rbx-forge.config.json": JSON.stringify(config),
		...files,
	});
	const bin = fixtureBins
		? createFixtureBinDirectory(path.join(project, "fixture-bin"))
		: emptyDirectory(path.join(project, "empty-bin"));
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

function emptyDirectory(directory: string): string {
	mkdirSync(directory);
	return directory;
}

function writeFiles(root: string, files: Record<string, string>): void {
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(root, name);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
}
