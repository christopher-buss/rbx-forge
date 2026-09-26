/**
 * `down` against real supervisors, reapers, and fixture workers. Each test
 * drives `stopSessionAsync` (the use-case of `forge down`) with the real
 * seams; `test/e2e/down.spec.ts` runs the built CLI.
 */
import { spawn } from "node:child_process";
import nodeFs, { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import type { DownOptions, DownReport } from "../../src/client/down.ts";
import { stopSessionAsync } from "../../src/client/down.ts";
import { fetchStatusAsync, findSession, stopPartsAsync } from "../../src/client/session.ts";
import { ForgeError } from "../../src/errors.ts";
import { nodeClock } from "../../src/seams/clock.ts";
import { nodeHost } from "../../src/seams/host.ts";
import type { IdentityRecord } from "../../src/supervisor/session-files.ts";
import { forgeFiles } from "../../src/supervisor/session-files.ts";
import { realTransport } from "../helpers/native-testing.ts";
import { pidOf, realNativePath, spawnSleeper } from "../helpers/real-native.ts";
import { isProcessAlive, waitForDeathAsync, waitForWorkersAsync } from "../helpers/worker-log.ts";
import type { Project } from "./session-harness.ts";
import {
	currentIdentity,
	filesLeft,
	launch,
	makeProjectAsync,
	native,
	ROJO_ONLY,
	stageOldSessionAsync,
	waitForAsync,
	waitForReadyAsync,
	workersOf,
} from "./session-harness.ts";

const LOCK_HOLDER = path.join(import.meta.dirname, "..", "fixtures", "bin", "lock-holder.ts");
/** A short wait: the scenarios never need the 15 s default. */
const SHORT = {
	force: false,
	keepStudio: false,
	// No Studio runs in these sessions; keep would touch no file either way.
	recovery: "keep",
	timeoutMs: 1000,
} satisfies DownOptions;

type Outcome = { error: ForgeError; ok: false } | { ok: true; report: DownReport };

/** A session `down` let start at one of its points. */
interface Replacement {
	/** The replacement's identity record, once it is ready. */
	identity: () => IdentityRecord;
	pause: NonNullable<DownOptions["pause"]>;
}

/**
 * Run `down` on the session `.forge/current` names.
 *
 * @param project - The fixture project, with its paths.
 * @param options - `--force`, the wait, and the test pause.
 * @returns Its report, or its error.
 */
async function downAsync(project: Project, options: DownOptions = SHORT): Promise<Outcome> {
	const forge = forgeFiles(project.project);
	const session = findSession(nodeFs, forge);
	assert(session !== undefined, "no session is named");
	try {
		const report = await stopSessionAsync(
			{
				clock: nodeClock,
				fileSystem: nodeFs,
				host: nodeHost,
				ipc: realTransport(),
				native: () => native,
			},
			forge,
			session,
			options,
		);
		return { ok: true, report };
	} catch (err) {
		assert(err instanceof ForgeError, String(err));
		return { error: err, ok: false };
	}
}

/**
 * Wait for a pause file and read the PID its process wrote.
 *
 * @param file - The pause file.
 * @returns The paused process's PID.
 */
async function pausedPidAsync(file: string): Promise<number> {
	const text = await waitForAsync(() => {
		const content = existsSync(file) ? readFileSync(file, "utf8") : "";
		return content === "" ? undefined : content;
	});
	return Number(text);
}

/**
 * Block the event loop of the project's supervisor for good (its
 * `RBX_FORGE_TEST_PAUSE` lists `block`).
 *
 * @param project - The fixture project, with its paths.
 * @returns The blocked supervisor's PID.
 */
async function blockSupervisorAsync(project: Project): Promise<number> {
	mkdirSync(project.pauses, { recursive: true });
	writeFileSync(path.join(project.pauses, "block.request"), "");
	return pausedPidAsync(path.join(project.pauses, "block.blocked"));
}

/**
 * A stale session: its directory and `current`, with an identity record
 * that names a supervisor by PID and start time, and no supervisor.
 *
 * @param project - The fixture project, with its paths.
 * @param sessionId - The session's id; its directory may exist.
 * @param supervisor - The PID and start time the record names.
 */
function stageRecord(
	project: Project,
	sessionId: string,
	{ pid, processStartTime }: Pick<IdentityRecord, "pid" | "processStartTime">,
): void {
	const directory = path.join(project.forge, "sessions", sessionId);
	mkdirSync(directory, { recursive: true });
	const now = new Date();
	const identity: IdentityRecord = {
		endpoint: path.join(project.project, "no-endpoint"),
		pid,
		processStartTime,
		sessionId,
		startedAt: now.toISOString(),
		version: "0.0.0",
	};
	writeFileSync(path.join(directory, "supervisor.id"), `${JSON.stringify(identity)}\n`);
	writeFileSync(path.join(directory, "token"), "token");
	writeFileSync(path.join(project.forge, "current"), `${sessionId}\n`);
}

/**
 * The PID of a process that has exited.
 *
 * @returns A PID no live process has, as far as this test knows.
 */
async function exitedPidAsync(): Promise<number> {
	const exited = spawnSleeper();
	const pid = pidOf(exited);
	exited.kill("SIGKILL");
	await waitForDeathAsync([pid]);
	return pid;
}

/**
 * A pause that notes, at `down`'s delete point, whether a file exists.
 *
 * @param file - The file to look for.
 * @returns The pause, and what it saw.
 */
function existenceAtDelete(file: string): {
	existed: Array<boolean>;
	pause: NonNullable<DownOptions["pause"]>;
} {
	const existed: Array<boolean> = [];
	return {
		existed,
		pause: async (point) => {
			if (point === "delete") {
				existed.push(existsSync(file));
			}
		},
	};
}

/**
 * A pause that starts a replacement session at `point`, once, and waits
 * until it is ready and its Rojo has started.
 *
 * @param project - The fixture project, with its paths.
 * @param at - Where `down` lets it start.
 * @param workers - How many worker records the log holds by then.
 * @returns The pause, and the replacement's record.
 */
function replaceAt(project: Project, at: string, workers: number): Replacement {
	let started: IdentityRecord | undefined;
	return {
		identity: () => {
			assert(started !== undefined, "no replacement started");
			return started;
		},
		pause: async (point) => {
			if (point !== at || started !== undefined) {
				return;
			}

			const second = launch(project);
			await waitForReadyAsync(second);
			started = currentIdentity(project);
			await waitForWorkersAsync(project.log, workers);
		},
	};
}

/**
 * Stage a stale record that names a live bystander process, run
 * `down --force`, and report what happened to the bystander.
 *
 * @param project - The fixture project, with its paths.
 * @param startTimeOf - The start time the record names for the bystander.
 * @returns The outcome, and whether the bystander still runs.
 */
async function downOnBystanderAsync(
	project: Project,
	startTimeOf: (pid: number) => string,
): Promise<{ isAlive: boolean; outcome: Outcome }> {
	const bystander = pidOf(spawnSleeper());
	stageRecord(project, "stale", { pid: bystander, processStartTime: startTimeOf(bystander) });
	const outcome = await downAsync(project, { ...SHORT, force: true });
	return { isAlive: isProcessAlive(bystander), outcome };
}

function liveStartTime(pid: number): string {
	const startTime = native.processStartTime(pid);
	assert(startTime !== null);
	return startTime;
}

function otherStartTime(): string {
	return "1";
}

/**
 * Hold the project's singleton lock from another process until the test
 * ends.
 *
 * @param project - The fixture project, with its paths.
 */
async function holdSingletonAsync(project: Project): Promise<void> {
	mkdirSync(project.forge, { recursive: true });
	const child = spawn(
		process.execPath,
		[LOCK_HOLDER, realNativePath(), path.join(project.forge, "supervisor.lock"), "exclusive"],
		{ stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
	);
	onTestFinished(() => {
		child.kill("SIGKILL");
	});
	const line = await new Promise<string>((resolve) => {
		child.stdout.setEncoding("utf8");
		child.stdout.once("data", resolve);
		// A lock holder that crashed wrote nothing.
		child.once("close", () => {
			resolve("");
		});
	});
	assert(line.trim() === "locked", "the lock holder did not get the lock");
}

function pidsOf(project: Project, sessionId: string): Array<number> {
	return workersOf(project, sessionId).map(({ pid }) => pid);
}

describe("forge down", () => {
	it("should wait through the workers' grace and report stopped only once all are gone", async () => {
		expect.assertions(3);

		const project = await makeProjectAsync({ gracefulTimeoutMs: 2000 });
		const run = launch(project, ROJO_ONLY, {
			FIXTURE_GRANDCHILDREN: "2",
			FIXTURE_IGNORE_SIGNALS: "1",
		});
		await waitForReadyAsync(run);
		const { pid, sessionId } = currentIdentity(project);
		await waitForWorkersAsync(project.log, 3);
		const started = Date.now();

		const outcome = await downAsync(project, { ...SHORT, timeoutMs: 15_000 });
		const elapsed = Date.now() - started;
		// Dead already; on POSIX a zombie still answers a signal-0 probe
		// until its parent reaps it.
		const alive = await waitForDeathAsync([pid, ...pidsOf(project, sessionId)], 2000);

		// The session stopped Rojo, waiting through its grace, then ended.
		expect(outcome).toStrictEqual({
			ok: true,
			report: {
				parts: { kept: [], stopped: ["rojo"] },
				removed: false,
				sessionId,
				status: "stopped",
				stoppedBy: "shutdown",
				studio: { status: "none" },
			},
		});
		expect(elapsed).toBeGreaterThanOrEqual(2000);
		expect({ alive, files: filesLeft(project) }).toStrictEqual({ alive: [], files: [] });
	}, 60_000);

	it("should leave a session running when a stop reaches none of its parts", async () => {
		expect.assertions(2);

		const project = await makeProjectAsync();
		const run = launch(project, ROJO_ONLY);
		await waitForReadyAsync(run);
		const session = findSession(nodeFs, forgeFiles(project.project));
		assert(session !== undefined, "no session is named");
		const stops = await stopPartsAsync(
			realTransport(),
			session,
			{ force: false, keepStudio: false, scope: "stop" },
			5000,
		);
		const status = await fetchStatusAsync(realTransport(), session);

		expect(stops).toStrictEqual({ ending: false, kept: [], stopped: [] });
		expect({ phase: status.phase, rojo: status.services.rojo.status }).toStrictEqual({
			phase: "ready",
			rojo: "ready",
		});
	}, 60_000);

	it("should never report stopped while a worker lives, and clean it up with --force", async () => {
		expect.assertions(4);

		const project = await makeProjectAsync();
		const old = await stageOldSessionAsync(project, [{ FIXTURE_GRANDCHILDREN: "1" }]);
		const records = await waitForWorkersAsync(project.log, 2);
		const workers = records.map(({ pid }) => pid);
		// Its supervisor is long gone.
		stageRecord(project, old.sessionId, {
			pid: await exitedPidAsync(),
			processStartTime: "1",
		});

		const refused = await downAsync(project);
		assert(!refused.ok && refused.error.details !== undefined, "expected cleanup_in_progress");

		expect(refused.error.code).toBe("cleanup_in_progress");
		expect(refused.error.details["pids"]).toIncludeAllMembers([old.reaper.pid, ...workers]);

		const forced = await downAsync(project, { ...SHORT, force: true });
		assert(forced.ok, "expected stopped");

		expect(forced.report).toMatchObject({ removed: true, stoppedBy: "gone" });
		expect({
			files: filesLeft(project),
			survivors: await waitForDeathAsync([old.reaper.pid, ...workers]),
		}).toStrictEqual({ files: [], survivors: [] });
	}, 60_000);

	it("should leave a replacement session that starts during down untouched", async () => {
		expect.assertions(2);

		const project = await makeProjectAsync();
		const first = launch(project);
		await waitForReadyAsync(first);
		const a = currentIdentity(project);
		await waitForWorkersAsync(project.log, 1);
		// B takes over and leases before A's barrier.
		const replacement = replaceAt(project, "barrier", 2);

		const outcome = await downAsync(project, { ...SHORT, pause: replacement.pause });
		const b = replacement.identity();

		expect(outcome).toMatchObject({ ok: true, report: { sessionId: a.sessionId } });
		expect({
			alive: [b.pid, ...pidsOf(project, b.sessionId)].every(isProcessAlive),
			files: filesLeft(project).toSorted(),
		}).toStrictEqual({ alive: true, files: ["current", b.sessionId].toSorted() });
	}, 60_000);

	it("should kill a blocked supervisor through its pin with --force, and never delete a new session's files", async () => {
		expect.assertions(4);

		const project = await makeProjectAsync();
		const first = launch(project, ROJO_ONLY, { RBX_FORGE_TEST_PAUSE: "block" });
		await waitForReadyAsync(first);
		const a = currentIdentity(project);
		await waitForWorkersAsync(project.log, 1);
		const blocked = await blockSupervisorAsync(project);

		const refused = await downAsync(project);

		expect({ blocked, refused }).toMatchObject({
			blocked: a.pid,
			refused: { error: { code: "supervisor_unresponsive" }, ok: false },
		});

		const replacement = replaceAt(project, "delete", 2);
		const forced = await downAsync(project, {
			...SHORT,
			force: true,
			pause: replacement.pause,
		});
		const b = replacement.identity();

		expect(forced).toMatchObject({
			ok: true,
			report: { sessionId: a.sessionId, stoppedBy: "killed" },
		});
		expect(filesLeft(project).toSorted()).toStrictEqual(["current", b.sessionId].toSorted());
		await expect(
			waitForDeathAsync([a.pid, ...pidsOf(project, a.sessionId)]),
		).resolves.toStrictEqual([]);
	}, 90_000);

	it("should never report stopped for a stalled startup, and kill it before any worker with --force", async () => {
		expect.assertions(4);

		const project = await makeProjectAsync();
		launch(project, ROJO_ONLY, { RBX_FORGE_TEST_PAUSE: "control,block" });
		const pause = path.join(project.pauses, "control.paused");
		const pid = await pausedPidAsync(pause);
		const { sessionId } = currentIdentity(project);

		const refused = await downAsync(project);

		expect(refused).toMatchObject({ error: { code: "supervisor_unresponsive" }, ok: false });

		// The loop blocks too, with no endpoint.
		await blockSupervisorAsync(project);
		const forced = await downAsync(project, { ...SHORT, force: true });
		rmSync(pause, { force: true });

		expect(forced).toMatchObject({ ok: true, report: { sessionId, stoppedBy: "killed" } });
		await expect(waitForDeathAsync([pid])).resolves.toStrictEqual([]);
		expect(workersOf(project, sessionId)).toStrictEqual([]);
	}, 90_000);

	it("should probe the barrier without creating a file in the session", async () => {
		expect.assertions(1);

		const project = await makeProjectAsync();
		// A session whose supervisor died before its reaper took a lease.
		stageRecord(project, "stale", { pid: await exitedPidAsync(), processStartTime: "1" });
		const atDelete = existenceAtDelete(
			path.join(project.forge, "sessions", "stale", "workers.lock"),
		);

		await downAsync(project, { ...SHORT, pause: atDelete.pause });

		expect(atDelete.existed).toStrictEqual([false]);
	});

	it("should kill nothing for a record whose PID another process reused", async () => {
		expect.assertions(1);

		const project = await makeProjectAsync();

		await expect(downOnBystanderAsync(project, otherStartTime)).resolves.toMatchObject({
			isAlive: true,
			outcome: { ok: true, report: { removed: true, stoppedBy: "gone" } },
		});
	});

	it("should kill nothing for a start time mismatch while the lock is held", async () => {
		expect.assertions(1);

		const project = await makeProjectAsync();
		await holdSingletonAsync(project);

		await expect(downOnBystanderAsync(project, otherStartTime)).resolves.toMatchObject({
			isAlive: true,
			outcome: { ok: true, report: { removed: false, stoppedBy: "gone" } },
		});
	});

	it("should kill nothing for a record with a live start time while the lock is free, and never report it stopped", async () => {
		expect.assertions(1);

		const project = await makeProjectAsync();

		await expect(downOnBystanderAsync(project, liveStartTime)).resolves.toMatchObject({
			isAlive: true,
			outcome: { error: { code: "supervisor_unresponsive" }, ok: false },
		});
	});
});
