/**
 * Real supervisors and reapers in a temporary Luau project with fake Rojo on
 * PATH, for the barrier and cleanup scenarios. Everything a test starts is
 * stopped when it finishes: supervisors get SIGTERM through their owner
 * pipe, paused reapers are resumed (so they stop their workers and exit),
 * and every fixture process still alive is killed.
 */
import { randomUUID } from "node:crypto";
import nodeFs, { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { onTestFinished } from "vitest";

import { findSession } from "../../src/client/session.ts";
import { callSessionAsync } from "../../src/ipc/client.ts";
import type { Reaper } from "../../src/reaper/reaper-client.ts";
import { launchReaperAsync } from "../../src/reaper/reaper-client.ts";
import { nodeChildProcessRunner } from "../../src/seams/child-process.ts";
import { nodeClock } from "../../src/seams/clock.ts";
import { nodeHost } from "../../src/seams/host.ts";
import type { CommandResult, ReporterEvent } from "../../src/seams/reporter.ts";
import type { SessionRequest } from "../../src/supervisor/channel.ts";
import { createSupervisorLauncher } from "../../src/supervisor/launcher.ts";
import type { IdentityRecord } from "../../src/supervisor/session-files.ts";
import { forgeFiles } from "../../src/supervisor/session-files.ts";
import { makeFixtureProject } from "../helpers/fixture-project.ts";
import { realTransport } from "../helpers/native-testing.ts";
import { loadRealNative, NATIVE_DIRECTORY, REAPER_PATH } from "../helpers/real-native.ts";
import type { WorkerRecord } from "../helpers/worker-log.ts";
import { killLoggedWorkersAsync, readWorkerLog, waitForDeathAsync } from "../helpers/worker-log.ts";

const SUPERVISOR = path.join(import.meta.dirname, "..", "..", "src", "supervisor.ts");
const FAKE_WORKER = path.join(import.meta.dirname, "..", "fixtures", "bin", "fake-worker.ts");
const PATH_NAME = /^path$/i;
const POLL_MS = 50;
const WAIT_MS = 30_000;
export const ROJO_ONLY: SessionRequest = { compiler: false, config: {}, open: false, rojo: true };
export const native = loadRealNative();

export interface Project {
	/** The environment of a supervisor or worker, with fixture variables. */
	env: (variables?: Record<string, string>) => NodeJS.ProcessEnv;
	/** `.forge` in the project. */
	forge: string;
	/** The fixture start log. */
	log: string;
	/** Where test pause points write their files. */
	pauses: string;
	project: string;
}

/** How a launched supervisor ended. */
export type Settled = { error: unknown; ok: false } | { ok: true; result: CommandResult };

export interface Launched {
	/** Every progress event so far. */
	events: Array<ReporterEvent>;
	/** Resolves once the supervisor has exited. */
	settled: Promise<Settled>;
	stop: (signal: NodeJS.Signals) => void;
}

/** A session a test staged by hand: its reaper, run from the test. */
export interface OldSession {
	directory: string;
	reaper: Reaper;
	sessionId: string;
}

/**
 * A Luau project with fake Rojo on PATH, on a free port, with no graceful
 * stop time: the barrier's bound is its 15 s margin alone.
 *
 * @param config - Config keys over those defaults.
 * @returns Its paths and environment.
 */
export async function makeProjectAsync(config: Record<string, unknown> = {}): Promise<Project> {
	const { log, project } = makeFixtureProject({
		config: {
			gracefulTimeoutMs: 0,
			projectType: "luau",
			rojoPort: await freePortAsync(),
			...config,
		},
	});
	const pauses = path.join(project, "pauses");
	onTestFinished(async () => {
		resumeAll(pauses);
		await killLoggedWorkersAsync(log);
	});
	return {
		env: environmentFor({ log, pauses, project }),
		forge: path.join(project, ".forge"),
		log,
		pauses,
		project,
	};
}

/**
 * Launch a supervisor, as `forge start` does: it owns the parts the session
 * starts with. The test's end stops it, and ends a session its stop let
 * run on.
 *
 * @param project - Where it runs.
 * @param request - What `start` asks for.
 * @param variables - Fixture and pause variables.
 * @returns The running supervisor.
 */
export function launch(
	project: Project,
	request: SessionRequest = ROJO_ONLY,
	variables: Record<string, string> = {},
): Launched {
	const events: Array<ReporterEvent> = [];
	const run = createSupervisorLauncher(
		{ childProcess: nodeChildProcessRunner, host: nodeHost },
		SUPERVISOR,
	)({
		cwd: project.project,
		env: project.env(variables),
		onEvent: (event) => {
			events.push(event);
		},
		request,
	});
	const settled = run.result
		.then((result): Settled => ({ ok: true, result }))
		.catch((err: unknown): Settled => ({ error: err, ok: false }));
	onTestFinished(async () => {
		run.stop("SIGTERM");
		const outcome = await settled;
		if (outcome.ok && outcome.result.data["ending"] === false) {
			await shutdownAsync(project);
		}
	});
	return { events, settled, stop: run.stop };
}

/**
 * Launch a supervisor with no owner, as `forge up` does, but with its
 * output on a pipe once the session is ready. Its parts have no owner.
 * `stop` asks it to shut down; the test's end does too.
 *
 * @param project - Where it runs.
 * @param request - What the session starts with.
 * @param variables - Fixture and pause variables.
 * @returns The running supervisor.
 */
export function launchUnowned(
	project: Project,
	request: SessionRequest = ROJO_ONLY,
	variables: Record<string, string> = {},
): Launched {
	const launches = path.join(project.forge, "launch");
	mkdirSync(launches, { recursive: true });
	const report = path.join(launches, `${randomUUID()}.ndjson`);
	const run = launch(project, { ...request, detached: { report } }, variables);
	onTestFinished(async () => {
		await shutdownAsync(project);
	});
	return {
		...run,
		stop: () => {
			void shutdownAsync(project);
		},
	};
}

/**
 * Wait until `check` returns something.
 *
 * @template T - What it returns.
 * @param check - Returns `undefined` until the condition holds.
 * @param timeoutMs - How long to try.
 * @returns What it returned.
 * @rejects When the bound passes first.
 */
export async function waitForAsync<T>(
	check: () => T | undefined,
	timeoutMs: number = WAIT_MS,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = check();
		if (value !== undefined) {
			return value;
		}

		if (Date.now() > deadline) {
			throw new Error("timed out");
		}

		await sleep(POLL_MS);
	}
}

/**
 * Wait until the supervisor has exited, within a bound, so a supervisor
 * that hangs fails the test at the phase it hung in, with its events.
 *
 * @param run - The running supervisor.
 * @param phase - What the test waits for, for the error.
 * @param timeoutMs - How long to wait.
 * @returns How it ended.
 * @rejects When the bound passes first.
 */
export async function settledWithinAsync(
	run: Launched,
	phase: string,
	timeoutMs: number,
): Promise<Settled> {
	const timer = new AbortController();
	const late = sleep(timeoutMs, undefined, { signal: timer.signal }).then(() => {
		throw new Error(
			`${phase}: the supervisor did not exit within ${timeoutMs} ms. Its events: ${JSON.stringify(run.events)}`,
		);
	});
	try {
		return await Promise.race([run.settled, late]);
	} finally {
		timer.abort();
		late.catch(() => {
			// Aborted once the supervisor exited.
		});
	}
}

/**
 * Wait until the supervisor reported the session ready.
 *
 * @param launched - The running supervisor.
 */
export async function waitForReadyAsync(launched: Launched): Promise<void> {
	await waitForAsync(() => launched.events.find(({ type }) => type === "info"));
}

/**
 * The identity record of the session `current` names.
 *
 * @param project - Where the session runs.
 * @returns The supervisor's PID, session id, and the rest of the record.
 */
export function currentIdentity(project: Project): IdentityRecord {
	const sessionId = readFileSync(path.join(project.forge, "current"), "utf8").trim();
	const file = path.join(project.forge, "sessions", sessionId, "supervisor.id");
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the supervisor writes this shape
	return JSON.parse(readFileSync(file, "utf8")) as unknown as IdentityRecord;
}

/**
 * The session directories and hint left in `.forge`.
 *
 * @param project - Where the sessions ran.
 * @returns `current` (when there) and every session id.
 */
export function filesLeft({ forge }: Project): Array<string> {
	const sessions = path.join(forge, "sessions");
	const current = existsSync(path.join(forge, "current")) ? ["current"] : [];
	return [...current, ...(existsSync(sessions) ? readdirSync(sessions) : [])];
}

/**
 * The fixture processes of one session, by their session marker.
 *
 * @param project - Where the session ran.
 * @param sessionId - Whose processes.
 * @returns Their start records.
 */
export function workersOf(project: Project, sessionId: string): Array<WorkerRecord> {
	return readWorkerLog(project.log).filter(({ markers }) => markers.session === sessionId);
}

/**
 * Stage an earlier session by hand: its directory under `.forge/sessions`
 * and a real reaper that holds its lease, run from this test, with one fake
 * Rojo per entry of `workers`. No supervisor runs it, as after its
 * supervisor died. The test's end stops the reaper and its workers.
 *
 * @param project - Where the session ran.
 * @param workers - Fixture variables of each worker.
 * @returns Its directory, id, and reaper.
 */
export async function stageOldSessionAsync(
	project: Project,
	workers: ReadonlyArray<Record<string, string>>,
): Promise<OldSession> {
	const sessionId = randomUUID();
	const directory = path.join(project.forge, "sessions", sessionId);
	const reaper = await launchOldReaperAsync(directory, sessionId);
	reaper.go();
	for (const [index, variables] of workers.entries()) {
		await reaper.spawnAsync({
			id: `old-${index}`,
			args: [FAKE_WORKER, "rojo", "serve"],
			cwd: project.project,
			env: project.env(variables),
			file: process.execPath,
		});
	}

	return { directory, reaper, sessionId };
}

/**
 * The environment of the project's processes: this process's, with the
 * fixture binaries alone on PATH, the fixture log, the addon, and the pause
 * directory.
 *
 * @param paths - The project, its fixture log, and its pause directory.
 * @returns Makes the environment with more variables.
 */
function environmentFor({
	log,
	pauses,
	project,
}: Pick<Project, "log" | "pauses" | "project">): Project["env"] {
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

	return (variables = {}) => {
		return {
			...base,
			FIXTURE_LOG: log,
			PATH: path.join(project, "fixture-bin"),
			RBX_FORGE_NATIVE_DIR: NATIVE_DIRECTORY,
			RBX_FORGE_TEST_PAUSE_DIR: pauses,
			...variables,
		};
	};
}

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
 * Resume every paused process: delete its pause file.
 *
 * @param pauses - Where the pause files are.
 */
function resumeAll(pauses: string): void {
	if (!existsSync(pauses)) {
		return;
	}

	for (const name of readdirSync(pauses)) {
		rmSync(path.join(pauses, name), { force: true });
	}
}

/**
 * Ask the project's session to shut down at once, and wait until its
 * supervisor is gone.
 *
 * @param project - Where it runs.
 */
async function shutdownAsync(project: Project): Promise<void> {
	const session = findSession(nodeFs, forgeFiles(project.project));
	if (session === undefined) {
		return;
	}

	const target = { endpoint: session.identity.endpoint, token: session.token };
	await callSessionAsync(realTransport(), target, "shutdown", {
		params: { force: true },
	}).catch(() => {
		// It is gone already, or never opened its endpoint.
	});
	await waitForDeathAsync([session.identity.pid], WAIT_MS);
}

async function launchOldReaperAsync(directory: string, sessionId: string): Promise<Reaper> {
	mkdirSync(path.join(directory, "output"), { recursive: true });
	const reaper = await launchReaperAsync(
		{
			childProcess: nodeChildProcessRunner,
			clock: nodeClock,
			host: nodeHost,
			native: () => native,
		},
		{
			file: REAPER_PATH,
			leasePath: path.join(directory, "workers.lock"),
			recordPath: path.join(directory, "reaper.json"),
			sessionId,
		},
	);
	onTestFinished(async () => {
		await reaper.terminateAsync(0);
	});
	return reaper;
}
