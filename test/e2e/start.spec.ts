/**
 * `forge start` as a real process, with fake Rojo, compiler, hook, and
 * Studio (`test/fixtures/bin/fake-worker.ts`) on PATH and the real reaper.
 * The process table is the oracle: every worker and grandchild must be gone.
 *
 * Real Roblox Studio never opens: the place is always the stand-in of
 * `open.spec.ts` (a batch file on Windows, where `start` picks the app by
 * file type), and the tests make and remove Studio's lock file themselves.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";

import { EXIT_FAILURE, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import { createFixtureBinDirectory } from "../helpers/fixture-bin.ts";
import { parseLines, parseResult } from "../helpers/output.ts";
import { NATIVE_DIRECTORY } from "../helpers/real-native.ts";
import type { WorkerRecord } from "../helpers/worker-log.ts";
import {
	isProcessAlive,
	killWorkers,
	readWorkerLog,
	waitForDeathAsync,
	waitForWorkersAsync,
} from "../helpers/worker-log.ts";
import { BIN, makeProject, runBinAsync } from "./run-bin.ts";

const FAKE_WORKER = path.join(import.meta.dirname, "..", "fixtures", "bin", "fake-worker.ts");
const IS_WINDOWS = process.platform === "win32";
const PATH_NAME = /^path$/i;
const ROJO_ONLY = ["start", "--no-open", "--no-compiler", "--json"];
/** Roles that run as reaper workers; Studio and its launcher do not. */
const WORKER_ROLES: ReadonlySet<string> = new Set(["hook", "rbxtsc", "rojo"]);

/** The place every session builds: the Studio stand-in of `open.spec.ts`. */
const PLACE = IS_WINDOWS ? "My Places/Studio Stand-in.cmd" : "My Places/game.rbxl";
const PLACE_CONTENT = IS_WINDOWS
	? `@cd /d "%SystemRoot%" & "${process.execPath}" "${FAKE_WORKER}" studio "%~f0" & exit\r\n`
	: "fake place\n";

interface Fixture {
	environment: (variables?: Record<string, string>) => NodeJS.ProcessEnv;
	log: string;
	/** The absolute path of {@link PLACE}. */
	place: string;
	port: number;
	project: string;
}

interface Session {
	child: ChildProcessWithoutNullStreams;
	/** Resolves with the exit code once the process has closed. */
	closed: Promise<null | number>;
	stdout: () => string;
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

/**
 * Listen on `port` of `127.0.0.1` until the test ends.
 *
 * @param port - The port to hold.
 */
async function holdPortAsync(port: number): Promise<void> {
	const server = createServer();
	await new Promise<void>((resolve) => {
		server.listen({ host: "127.0.0.1", port }, resolve);
	});
	onTestFinished(() => {
		server.close();
	});
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

async function makeFixtureAsync(config: Record<string, unknown> = {}): Promise<Fixture> {
	const port = await freePortAsync();
	const project = makeProject();
	writeFileSync(
		path.join(project, "default.project.json"),
		JSON.stringify({ name: "fixture", tree: { $className: "DataModel" } }),
	);
	writeFileSync(
		path.join(project, "rbx-forge.config.json"),
		JSON.stringify({ buildOutputPath: PLACE, projectType: "luau", rojoPort: port, ...config }),
	);
	const place = path.join(project, PLACE);
	mkdirSync(path.dirname(place), { recursive: true });
	const bin = createFixtureBinDirectory(path.join(project, "fixture-bin"));
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
				FIXTURE_PLACE_CONTENT: PLACE_CONTENT,
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
function startSession(
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
async function waitForOutputAsync(session: Session, text: string): Promise<void> {
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
async function waitForRoleAsync(log: string, role: string): Promise<WorkerRecord> {
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

function workersOf(log: string): Array<WorkerRecord> {
	return readWorkerLog(log).filter(({ role }) => WORKER_ROLES.has(role));
}

function describeWorker({ args, role }: WorkerRecord): string {
	return [role, ...args].join(" ");
}

describe("forge start", () => {
	it("should run the whole workflow and leave zero survivors once Studio closes the place (W1)", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync({
			hooks: { syncback: { post: ["hook"] } },
			projectType: "rbxts",
		});
		const session = startSession(fixture, ["start", "--syncback", "--json"], {
			FIXTURE_GRANDCHILDREN: "1",
		});
		await waitForOutputAsync(session, "Press Ctrl+C to stop.");
		const studio = await waitForRoleAsync(fixture.log, "studio");
		writeFileSync(`${fixture.place}.lock`, `${studio.pid}\n`);
		await waitForOutputAsync(session, "The session ends when Studio closes it.");
		// Studio saves the place.
		const later = new Date(Date.now() + 60_000);
		utimesSync(fixture.place, later, later);
		await waitForRoleAsync(fixture.log, "hook");
		rmSync(`${fixture.place}.lock`);
		const status = await session.closed;
		const workers = workersOf(fixture.log);
		const sessions = new Set(workers.map(({ markers }) => markers.session));

		// Every worker, the hook included, is a worker of one session's reaper.
		expect({
			result: parseResult(session.stdout()),
			sessions: sessions.size,
			status,
		}).toMatchObject({
			result: { data: { reason: "studio_closed" } },
			sessions: 1,
			status: EXIT_SUCCESS,
		});
		// Rojo and the compiler start their processes at about the same time.
		expect(workers.map(describeWorker)).toIncludeSameMembers([
			"rojo syncback --help",
			"rbxtsc",
			`rojo build default.project.json --output ${PLACE}`,
			`rojo serve default.project.json --port ${fixture.port}`,
			"rbxtsc -w",
			"rojo syncback --help",
			`rojo syncback default.project.json --input ${PLACE} --non-interactive`,
			"hook",
		]);
		expect(parseLines(session.stdout())).toContainEqual({
			diagnostics: [],
			errors: 0,
			type: "compiled",
		});

		const others = readWorkerLog(fixture.log).filter(({ role }) => role !== "studio");

		// Every process is gone but Studio, which the session never owned.
		expect({
			isStudioAlive: isProcessAlive(studio.pid),
			survivors: await waitForDeathAsync(others.map(({ pid }) => pid)),
		}).toStrictEqual({ isStudioAlive: true, survivors: [] });
	});

	it("should run Rojo and the compiler without Studio with --no-open, and stop with service_failed:compiler when it exits", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync({ projectType: "rbxts" });
		const session = startSession(fixture, ["start", "--no-open", "--json"], {
			FIXTURE_EXIT_AFTER_MS: "3000",
			FIXTURE_EXIT_ROLE: "rbxtsc",
		});
		const status = await session.closed;

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(session.stdout()).error).toMatchObject({
			code: "service_failed",
			details: { reason: "service_failed:compiler" },
		});
		expect(readWorkerLog(fixture.log).map(({ role }) => role)).not.toContain("studio");
		await expect(
			waitForDeathAsync(readWorkerLog(fixture.log).map(({ pid }) => pid)),
		).resolves.toStrictEqual([]);
	});

	it("should kill a hook's whole tree when start is hard-killed while the hook runs", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync({
			hooks: { build: { pre: ["hook"] } },
			projectType: "rbxts",
		});
		const session = startSession(fixture, ["start", "--no-open", "--json"], {
			FIXTURE_GRANDCHILDREN: "2",
			FIXTURE_HANG: "1",
		});
		// The compile, then the hook and its two grandchildren.
		const records = await waitForWorkersAsync(fixture.log, 4, 30_000);
		session.child.kill("SIGKILL");
		await session.closed;
		const hook = records.filter(({ markers }) => markers.worker === "start-2");

		expect(hook.map(({ role }) => role)).toStrictEqual(["hook", "grandchild", "grandchild"]);
		await expect(waitForDeathAsync(records.map(({ pid }) => pid))).resolves.toStrictEqual([]);
	});
});

describe("forge start --no-open --no-compiler", () => {
	it("should serve on the fixed port and leave zero survivors when start is hard-killed (L2)", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		const session = startSession(fixture, ROJO_ONLY, { FIXTURE_GRANDCHILDREN: "2" });
		const records = await waitForWorkersAsync(fixture.log, 3, 30_000);
		// A hard kill: no handler in forge runs. Only the reaper's stdin EOF
		// is left to end the workers.
		session.child.kill("SIGKILL");
		await session.closed;

		expect(records[0]).toMatchObject({
			args: ["serve", "default.project.json", "--port", String(fixture.port)],
			role: "rojo",
		});
		expect(records.map(({ markers }) => markers.worker)).toStrictEqual([
			"rojo",
			"rojo",
			"rojo",
		]);
		await expect(waitForDeathAsync(records.map(({ pid }) => pid))).resolves.toStrictEqual([]);
	});

	it("should report ready once Rojo runs", async () => {
		expect.assertions(1);

		const fixture = await makeFixtureAsync();
		const session = startSession(fixture, ROJO_ONLY);
		await waitForOutputAsync(session, "Press Ctrl+C to stop.");

		expect(parseLines(session.stdout())).toStrictEqual([
			{ name: "rojo serve", status: "started", type: "step" },
			{ name: "rojo serve", status: "succeeded", type: "step" },
			{
				message: `Rojo serves default.project.json on port ${fixture.port}. Press Ctrl+C to stop.`,
				type: "info",
			},
		]);
	});

	// Windows cannot send SIGTERM to another process: `kill` terminates it.
	it.skipIf(IS_WINDOWS)("should stop every worker on SIGTERM and exit 0 (L1)", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		const session = startSession(fixture, ROJO_ONLY, { FIXTURE_GRANDCHILDREN: "2" });
		const records = await waitForWorkersAsync(fixture.log, 3, 30_000);
		session.child.kill("SIGTERM");
		const status = await session.closed;

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseResult(session.stdout()).data).toMatchObject({
			port: fixture.port,
			reason: "SIGTERM",
		});
		await expect(waitForDeathAsync(records.map(({ pid }) => pid))).resolves.toStrictEqual([]);
	});

	it("should stop the session with service_failed when Rojo exits, killing what it left", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		const session = startSession(fixture, ROJO_ONLY, {
			FIXTURE_EXIT_AFTER_MS: "1500",
			FIXTURE_EXIT_CODE: "3",
			FIXTURE_GRANDCHILDREN: "2",
		});
		const records = await waitForWorkersAsync(fixture.log, 3, 30_000);
		const status = await session.closed;

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(session.stdout()).error).toMatchObject({
			code: "service_failed",
			details: { reason: "service_failed:rojo" },
		});
		await expect(waitForDeathAsync(records.map(({ pid }) => pid))).resolves.toStrictEqual([]);
	});

	it("should fail with port_in_use when the fixed port is busy, starting nothing", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		await holdPortAsync(fixture.port);
		const { status, stdout } = await runBinAsync(
			ROJO_ONLY,
			fixture.project,
			fixture.environment(),
		);

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout).error!.code).toBe("port_in_use");
		expect(readWorkerLog(fixture.log)).toStrictEqual([]);
	});
});
