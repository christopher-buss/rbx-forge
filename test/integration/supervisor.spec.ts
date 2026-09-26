/**
 * The supervisor as a real process (run from source with the current Node),
 * with the real reaper and addon and fake Rojo on PATH: the session files it
 * keeps while it runs, and its end on a stop request and on owner-pipe EOF.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { nodeChildProcessRunner } from "../../src/seams/child-process.ts";
import { nodeHost } from "../../src/seams/host.ts";
import type { ReporterEvent } from "../../src/seams/reporter.ts";
import type { SessionRequest, SupervisorMessage } from "../../src/supervisor/channel.ts";
import { encodeSessionRequest, parseMessage } from "../../src/supervisor/channel.ts";
import { createSupervisorLauncher } from "../../src/supervisor/launcher.ts";
import type { IdentityRecord } from "../../src/supervisor/session-files.ts";
import { makeFixtureProject } from "../helpers/fixture-project.ts";
import { loadRealNative, NATIVE_DIRECTORY } from "../helpers/real-native.ts";
import { isProcessAlive, readWorkerLog, waitForDeathAsync } from "../helpers/worker-log.ts";

const SUPERVISOR = path.join(import.meta.dirname, "..", "..", "src", "supervisor.ts");
const PATH_NAME = /^path$/i;
const ROJO_ONLY: SessionRequest = { compiler: false, config: {}, open: false };
const WAIT_MS = 20_000;
const native = loadRealNative();

interface Project {
	env: NodeJS.ProcessEnv;
	/** `.forge` in the project. */
	forge: string;
	log: string;
	project: string;
}

interface ReaperRecord {
	pid: number;
	sessionId: string;
	startTime: string;
	workers: Array<{ id: string; pid: number; startTime: string }>;
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
 * A Luau project with fake Rojo on PATH, on a free port.
 *
 * @returns The project and the supervisor's environment.
 */
async function makeSessionProjectAsync(): Promise<Project> {
	const { log, project } = makeFixtureProject({
		config: { projectType: "luau", rojoPort: await freePortAsync() },
	});
	const environment: NodeJS.ProcessEnv = { ...process.env, CI: undefined };
	for (const key of Object.keys(environment)) {
		if (PATH_NAME.test(key)) {
			delete environment[key];
		}
	}

	return {
		env: {
			...environment,
			FIXTURE_GRANDCHILDREN: "1",
			FIXTURE_LOG: log,
			PATH: path.join(project, "fixture-bin"),
			RBX_FORGE_NATIVE_DIR: NATIVE_DIRECTORY,
		},
		forge: path.join(project, ".forge"),
		log,
		project,
	};
}

/**
 * Wait until `check` returns something.
 *
 * @template T - What it returns.
 * @param check - Returns `undefined` until the condition holds.
 * @returns What it returned.
 * @rejects When {@link WAIT_MS} pass first.
 */
async function waitForAsync<T>(check: () => T | undefined): Promise<T> {
	const deadline = Date.now() + WAIT_MS;
	for (;;) {
		const value = check();
		if (value !== undefined) {
			return value;
		}

		if (Date.now() > deadline) {
			throw new Error("timed out");
		}

		await sleep(50);
	}
}

function readIdentity(directory: string): IdentityRecord {
	const text = readFileSync(path.join(directory, "supervisor.id"), "utf8");
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the supervisor writes this shape
	return JSON.parse(text) as unknown as IdentityRecord;
}

function readRecord(directory: string): ReaperRecord {
	const text = readFileSync(path.join(directory, "reaper.json"), "utf8");
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the reaper writes this shape
	return JSON.parse(text) as unknown as ReaperRecord;
}

function sessionDirectory({ forge }: Project): string {
	const sessionId = readFileSync(path.join(forge, "current"), "utf8").trim();
	return path.join(forge, "sessions", sessionId);
}

function filesLeft({ forge }: Project): Array<string> {
	const sessions = path.join(forge, "sessions");
	const current = existsSync(path.join(forge, "current")) ? ["current"] : [];
	return [...current, ...(existsSync(sessions) ? readdirSync(sessions) : [])];
}

describe("supervisor", () => {
	it("should keep the session files while it runs and delete them once a stop request ended it", async () => {
		expect.assertions(4);

		const project = await makeSessionProjectAsync();
		const events: Array<ReporterEvent> = [];
		const run = createSupervisorLauncher(
			{ childProcess: nodeChildProcessRunner, host: nodeHost },
			SUPERVISOR,
		)({
			cwd: project.project,
			env: project.env,
			onEvent: (event) => {
				events.push(event);
			},
			request: ROJO_ONLY,
		});
		onTestFinished(() => {
			run.stop("SIGTERM");
		});
		await waitForAsync(() => events.find(({ type }) => type === "info"));
		const directory = sessionDirectory(project);
		const identity = readIdentity(directory);
		const record = readRecord(directory);

		expect({
			isLockHeld: native.tryLockFile(
				path.join(project.forge, "supervisor.lock"),
				"exclusive",
			),
			isTokenWritten: readFileSync(path.join(directory, "token"), "utf8").length > 0,
			startTime: native.processStartTime(identity.pid),
			version: identity.version,
		}).toStrictEqual({
			isLockHeld: null,
			isTokenWritten: true,
			startTime: identity.processStartTime,
			version: packageJson.version,
		});
		expect({ record, sessionId: identity.sessionId }).toMatchObject({
			record: {
				sessionId: path.basename(directory),
				startTime: native.processStartTime(record.pid),
				// The leader: on Windows the shim's cmd.exe, not fake Rojo.
				workers: [
					{ id: "rojo", startTime: native.processStartTime(record.workers[0]!.pid) },
				],
			},
			sessionId: path.basename(directory),
		});

		run.stop("SIGINT");

		await expect(run.result).resolves.toMatchObject({ data: { reason: "SIGINT" } });
		expect({
			files: filesLeft(project),
			survivors: await waitForDeathAsync(
				[identity.pid, record.pid, ...readWorkerLog(project.log).map(({ pid }) => pid)],
				WAIT_MS,
			),
		}).toStrictEqual({ files: [], survivors: [] });
	}, 60_000);

	it("should stop the session with owner_gone at owner-pipe EOF, leaving nothing", async () => {
		expect.assertions(2);

		const project = await makeSessionProjectAsync();
		const child = spawn(process.execPath, [SUPERVISOR, encodeSessionRequest(ROJO_ONLY)], {
			cwd: project.project,
			env: project.env,
			stdio: ["pipe", "pipe", "inherit"],
			windowsHide: true,
		});
		onTestFinished(() => {
			child.kill("SIGKILL");
		});
		const messages = collectMessages(child.stdout);
		const closed = new Promise((resolve) => {
			child.once("close", resolve);
		});
		await waitForAsync(() => messages.find(isReadyMessage));
		child.stdin.end();
		await closed;

		expect(messages.at(-1)).toMatchObject({ data: { reason: "owner_gone" }, ok: true });
		expect({
			alive: readWorkerLog(project.log).filter(({ pid }) => isProcessAlive(pid)),
			files: filesLeft(project),
		}).toStrictEqual({ alive: [], files: [] });
	}, 60_000);
});

function isReadyMessage(message: SupervisorMessage): boolean {
	return message.type === "event" && message.event.type === "info";
}

/**
 * Collect every supervisor message a stream carries.
 *
 * @param stream - The supervisor's stdout.
 * @returns The messages so far; it grows as lines arrive.
 */
function collectMessages(stream: NodeJS.ReadableStream): Array<SupervisorMessage> {
	const messages: Array<SupervisorMessage> = [];
	createInterface({ input: stream }).on("line", (line) => {
		const message = parseMessage(line);
		if (message !== undefined) {
			messages.push(message);
		}
	});
	return messages;
}
