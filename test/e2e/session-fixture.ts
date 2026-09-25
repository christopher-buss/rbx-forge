/**
 * A `forge start` session as a real process, for e2e tests: a temporary
 * project with fake Rojo, compiler, hook, and Studio
 * (`test/fixtures/bin/fake-worker.ts`) on PATH, the real reaper, and the
 * Studio stand-in place, so real Roblox Studio never opens.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { onTestFinished } from "vitest";

import { createFixtureBinDirectory } from "../helpers/fixture-bin.ts";
import { makeStudioExecutable, NATIVE_DIRECTORY, studioVariables } from "../helpers/real-native.ts";
import type { WorkerRecord } from "../helpers/worker-log.ts";
import { killWorkers, readWorkerLog } from "../helpers/worker-log.ts";
import { BIN, makeProject } from "./run-bin.ts";

const FAKE_WORKER = path.join(import.meta.dirname, "..", "fixtures", "bin", "fake-worker.ts");
export const IS_WINDOWS = process.platform === "win32";

const PATH_NAME = /^path$/i;
export const ROJO_ONLY = ["start", "--no-open", "--no-compiler", "--json"];
/** Roles that run as reaper workers; Studio and its launcher do not. */
export const WORKER_ROLES: ReadonlySet<string> = new Set(["hook", "rbxtsc", "rojo"]);

/** The place every session builds: the Studio stand-in of `open.spec.ts`. */
export const PLACE = IS_WINDOWS ? "My Places/Studio Stand-in.cmd" : "My Places/game.rbxl";

/** What a fixture's Studio stand-in does. */
export interface FixtureOptions {
	/**
	 * Behave as Studio: run as a Studio executable, write the place's lock
	 * file, and close on a close request (`test/fixtures/bin/fake-worker.ts`).
	 * Otherwise it only stays alive, and a test writes the lock file.
	 */
	studio?: boolean;
}

export interface Fixture {
	environment: (variables?: Record<string, string>) => NodeJS.ProcessEnv;
	log: string;
	/** The absolute path of {@link PLACE}. */
	place: string;
	port: number;
	project: string;
}

export interface Session {
	child: ChildProcessWithoutNullStreams;
	/** Resolves with the exit code once the process has closed. */
	closed: Promise<null | number>;
	stdout: () => string;
}

/**
 * Listen on `port` of `127.0.0.1` until the test ends.
 *
 * @param port - The port to hold.
 */
export async function holdPortAsync(port: number): Promise<void> {
	const server = createServer();
	await new Promise<void>((resolve) => {
		server.listen({ host: "127.0.0.1", port }, resolve);
	});
	onTestFinished(() => {
		server.close();
	});
}

/**
 * A temporary session project on a free Rojo port. Every fixture process
 * still alive at the test's end is killed.
 *
 * @param config - Config keys, such as `projectType` or `hooks`.
 * @param options - What the Studio stand-in does.
 * @returns The project, its fixture log, and its environment.
 */
export async function makeFixtureAsync(
	config: Record<string, unknown> = {},
	options: FixtureOptions = {},
): Promise<Fixture> {
	const port = await freePortAsync();
	const project = makeProject();
	const place = writeProjectFiles(project, { rojoPort: port, ...config });
	const bin = createFixtureBinDirectory(path.join(project, "fixture-bin"));
	const studio = options.studio === true ? makeStudioExecutable() : undefined;
	const log = path.join(project, "workers.ndjson");
	onTestFinished(() => {
		killWorkers(readWorkerLog(log));
	});

	const base = baseEnvironment();
	return {
		environment: (variables = {}) => {
			return {
				...base,
				FIXTURE_LOG: log,
				FIXTURE_PLACE_CONTENT: placeContent(studio ?? process.execPath),
				...(studio === undefined ? {} : studioVariables(studio)),
				PATH: bin,
				RBX_FORGE_NATIVE_DIR: NATIVE_DIRECTORY,
				...variables,
			};
		},
		log,
		place,
		port,
		project,
	};
}

/**
 * Start `forge start` and keep it running until it ends or the test kills it.
 *
 * @param fixture - The project and its environment.
 * @param argv - Arguments after `forge`.
 * @param variables - Fixture variables for the workers.
 * @returns The running process.
 */
export function startSession(
	fixture: Fixture,
	argv: Array<string>,
	variables: Record<string, string> = {},
): Session {
	const child = spawn(process.execPath, [BIN, ...argv], {
		cwd: fixture.project,
		env: fixture.environment(variables),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	onTestFinished(() => {
		child.kill("SIGKILL");
	});
	let stdout = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.resume();

	return {
		child,
		closed: new Promise((resolve) => {
			child.once("close", resolve);
		}),
		stdout: () => stdout,
	};
}

/**
 * Wait until the session's stdout holds `text`.
 *
 * @param session - The running session.
 * @param text - What to wait for.
 * @rejects When 30 seconds pass first.
 */
export async function waitForOutputAsync(session: Session, text: string): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (!session.stdout().includes(text)) {
		if (Date.now() > deadline) {
			throw new Error(`expected "${text}" in:\n${session.stdout()}`);
		}

		await sleep(50);
	}
}

/**
 * Wait until a fixture process with this role has started.
 *
 * @param log - The fixture log.
 * @param role - Such as `hook` or `studio`.
 * @returns Its record.
 * @rejects When 30 seconds pass first.
 */
export async function waitForRoleAsync(log: string, role: string): Promise<WorkerRecord> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const record = readWorkerLog(log).find((entry) => entry.role === role);
		if (record !== undefined) {
			return record;
		}

		if (Date.now() > deadline) {
			throw new Error(`expected a ${role} in ${log}`);
		}

		await sleep(50);
	}
}

/**
 * What `rojo build` writes to the place: on Windows, the batch file that
 * stands in for Studio (see `open.spec.ts`).
 *
 * @param studio - The path of the program the stand-in runs: Node, or a
 *   copy of Node named as Studio.
 * @returns What the place file holds.
 */
function placeContent(studio: string): string {
	return IS_WINDOWS
		? `@cd /d "%SystemRoot%" & "${studio}" "${FAKE_WORKER}" studio "%~f0" & exit\r\n`
		: "fake place\n";
}

/**
 * Write the Rojo project, the config, and the place's folder.
 *
 * @param project - The project directory.
 * @param config - Config keys over the defaults of every session test.
 * @returns The absolute path of {@link PLACE}.
 */
function writeProjectFiles(project: string, config: Record<string, unknown>): string {
	writeFileSync(
		path.join(project, "default.project.json"),
		JSON.stringify({ name: "fixture", tree: { $className: "DataModel" } }),
	);
	writeFileSync(
		path.join(project, "rbx-forge.config.json"),
		JSON.stringify({ buildOutputPath: PLACE, projectType: "luau", ...config }),
	);
	const place = path.join(project, PLACE);
	mkdirSync(path.dirname(place), { recursive: true });
	return place;
}

/**
 * A port nothing listens on right now.
 *
 * @returns A port that was free a moment ago.
 */
async function freePortAsync(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => {
		server.listen({ host: "127.0.0.1", port: 0 }, resolve);
	});
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a TCP server's address is an object
	const { port } = server.address() as AddressInfo;
	await new Promise((resolve) => {
		server.close(resolve);
	});
	return port;
}

function baseEnvironment(): NodeJS.ProcessEnv {
	const base: NodeJS.ProcessEnv = {
		...process.env,
		CI: undefined,
		RBX_FORGE_HOOK_STACK: undefined,
	};
	for (const key of Object.keys(base)) {
		if (PATH_NAME.test(key)) {
			delete base[key];
		}
	}

	return base;
}
