/**
 * The supervisor of `forge start` as a real process tree: the singleton, and
 * scenario W2 of spec #28: killing `start` at each startup point ends the
 * session with zero survivors, and no worker starts after the kill.
 *
 * The supervisor's test pause points (`RBX_FORGE_TEST_PAUSE`) hold it at a
 * startup point until the test kills `start`. Real Roblox Studio never opens:
 * every session here runs with `--no-open`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";

import { EXIT_FAILURE } from "../../src/exit-codes.ts";
import { parseResult } from "../helpers/output.ts";
import type { WorkerRecord } from "../helpers/worker-log.ts";
import { isProcessAlive, readWorkerLog, waitForDeathAsync } from "../helpers/worker-log.ts";
import { runBinAsync } from "./run-bin.ts";
import type { Fixture, Session } from "./session-fixture.ts";
import {
	IS_WINDOWS,
	makeFixtureAsync,
	ROJO_ONLY,
	startSession,
	waitForOutputAsync,
	waitForRoleAsync,
} from "./session-fixture.ts";

/** Compile and build, then Rojo and the compiler; no Studio. */
const NO_OPEN = ["start", "--no-open", "--json"];
const READY = "Press Ctrl+C to stop.";
const WAIT_MS = 30_000;
const POLL_MS = 50;
/** How long the fixture log must stay unchanged before the kill. */
const QUIET_MS = 1000;

/** How the test ends `start`. */
type Kill = "SIGHUP" | "SIGKILL";

/** One startup point of W2 and how the test reaches it. */
interface StartupPoint {
	name: string;
	/**
	 * Wait until the session is there.
	 *
	 * @returns The supervisor's PID.
	 */
	reach: (fixture: Fixture, session: Session) => Promise<number>;
	/** Fixture variables that hold the session there. */
	variables: Record<string, string>;
}

/**
 * Wait until `file` exists.
 *
 * @param file - The file to wait for.
 * @returns The file's text once it exists.
 * @rejects When 30 seconds pass first.
 */
async function waitForFileAsync(file: string): Promise<string> {
	const deadline = Date.now() + WAIT_MS;
	while (!existsSync(file)) {
		if (Date.now() > deadline) {
			throw new Error(`expected ${file}`);
		}

		await sleep(POLL_MS);
	}

	return readFileSync(file, "utf8");
}

function pauseDirectory(fixture: Fixture): string {
	return path.join(fixture.project, "pauses");
}

/**
 * The supervisor's PID from the identity record of the current session.
 *
 * @param fixture - The project whose session to read.
 * @returns The PID of the process that runs the session.
 */
async function supervisorPidAsync(fixture: Fixture): Promise<number> {
	const forge = path.join(fixture.project, ".forge");
	const current = await waitForFileAsync(path.join(forge, "current"));
	const sessionId = current.trim();
	const identity = readFileSync(path.join(forge, "sessions", sessionId, "supervisor.id"), "utf8");
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the supervisor writes this shape
	return (JSON.parse(identity) as unknown as { pid: number }).pid;
}

/**
 * Hold the supervisor at a pause point.
 *
 * @param point - The pause point.
 * @returns The startup point.
 */
function pausedAt(point: string): Pick<StartupPoint, "reach" | "variables"> {
	return {
		reach: async (fixture) => {
			const pid = await waitForFileAsync(
				path.join(pauseDirectory(fixture), `${point}.paused`),
			);
			return Number(pid);
		},
		variables: { RBX_FORGE_TEST_PAUSE: point },
	};
}

/**
 * Hold the session while a one-shot step of this fixture role runs.
 *
 * @param role - `rbxtsc` (compile) or `rojo` (build).
 * @returns The startup point.
 */
function duringStep(role: string): Pick<StartupPoint, "reach" | "variables"> {
	return {
		reach: async (fixture) => {
			await waitForRoleAsync(fixture.log, role);
			return supervisorPidAsync(fixture);
		},
		variables: { FIXTURE_HANG_ROLE: role },
	};
}

const STARTUP_POINTS: ReadonlyArray<StartupPoint> = [
	{ name: "right after the supervisor starts", ...pausedAt("created") },
	{ name: "before the singleton lock", ...pausedAt("lock") },
	{ name: "during the compile", ...duringStep("rbxtsc") },
	{ name: "during the build", ...duringStep("rojo") },
	{ name: "after the reaper leased, before go", ...pausedAt("leased") },
	{ name: "right after go", ...pausedAt("admitted") },
	{
		name: "once the session is ready",
		reach: async (fixture, session) => {
			await waitForOutputAsync(session, READY);
			return supervisorPidAsync(fixture);
		},
		variables: {},
	},
];

/** Windows has no SIGHUP to send: a closed terminal is POSIX only here. */
const KILLS: ReadonlyArray<Kill> = IS_WINDOWS ? ["SIGKILL"] : ["SIGKILL", "SIGHUP"];

/**
 * The reaper's PID, when the session has a reaper record.
 *
 * @param fixture - The project.
 * @returns The PID, or none.
 */
function reaperPids(fixture: Fixture): Array<number> {
	const sessions = path.join(fixture.project, ".forge", "sessions");
	if (!existsSync(sessions)) {
		return [];
	}

	return readdirSync(sessions)
		.map((id) => path.join(sessions, id, "reaper.json"))
		.filter((record) => existsSync(record))
		.map((record) => {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the reaper writes this shape
			return (JSON.parse(readFileSync(record, "utf8")) as unknown as { pid: number }).pid;
		});
}

/**
 * Kill a process when the test ends, if it still runs: a supervisor that
 * outlived a failed test.
 *
 * @param pid - The process.
 */
function killOnFinish(pid: number): void {
	onTestFinished(() => {
		if (isProcessAlive(pid)) {
			process.kill(pid, "SIGKILL");
		}
	});
}

/**
 * Wait until no fixture process has written a record for a while: every
 * process that started before the kill has written its own, so a record
 * written after the kill is a process that started after it.
 *
 * @param log - The fixture log.
 */
async function waitForQuietLogAsync(log: string): Promise<void> {
	let count = readWorkerLog(log).length;
	let quietSince = Date.now();
	while (Date.now() - quietSince < QUIET_MS) {
		await sleep(POLL_MS);
		const now = readWorkerLog(log).length;
		if (now !== count) {
			count = now;
			quietSince = Date.now();
		}
	}
}

function startedAfter(records: ReadonlyArray<WorkerRecord>, time: number): Array<WorkerRecord> {
	return records.filter(({ at }) => at > time);
}

/**
 * What is left of the project's session files: every session directory and
 * the `current` hint.
 *
 * @param fixture - The project.
 * @returns Relative paths.
 */
function sessionFilesLeft(fixture: Fixture): Array<string> {
	const forge = path.join(fixture.project, ".forge");
	const sessions = path.join(forge, "sessions");
	const directories = existsSync(sessions) ? readdirSync(sessions) : [];
	const current = existsSync(path.join(forge, "current")) ? ["current"] : [];
	return [...current, ...directories.map((id) => `sessions/${id}`)];
}

describe("forge start supervisor", () => {
	it("should refuse a second start in the project with session_running, leaving the first alone", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		const first = startSession(fixture, ROJO_ONLY);
		await waitForOutputAsync(first, READY);
		const second = await runBinAsync(ROJO_ONLY, fixture.project, fixture.environment());
		const rojo = readWorkerLog(fixture.log).filter(({ role }) => role === "rojo");

		expect(second.status).toBe(EXIT_FAILURE);
		expect(parseResult(second.stdout).error).toMatchObject({ code: "session_running" });
		expect(rojo.map(({ pid }) => isProcessAlive(pid))).toStrictEqual([true]);
	});

	describe("killing start at a startup point (W2)", () => {
		it.for(
			STARTUP_POINTS.flatMap((point) => {
				return KILLS.map((kill) => [point.name, kill, point] as const);
			}),
		)(
			"should leave zero survivors when killed %s (%s), starting no worker after the kill",
			async ([, kill, point]) => {
				expect.assertions(3);

				const fixture = await makeFixtureAsync({ projectType: "rbxts" });
				const session = startSession(fixture, NO_OPEN, {
					FIXTURE_GRANDCHILDREN: "1",
					RBX_FORGE_TEST_PAUSE_DIR: pauseDirectory(fixture),
					...point.variables,
				});
				const supervisor = await point.reach(fixture, session);
				killOnFinish(supervisor);
				await waitForQuietLogAsync(fixture.log);
				const reapers = reaperPids(fixture);
				const killedAt = Date.now();
				session.child.kill(kill);
				await session.closed;
				const survivors = await waitForDeathAsync([supervisor, ...reapers], WAIT_MS);
				const records = readWorkerLog(fixture.log);

				expect({
					startedAfterKill: startedAfter(records, killedAt),
					survivors,
				}).toStrictEqual({ startedAfterKill: [], survivors: [] });
				await expect(
					waitForDeathAsync(
						records.map(({ pid }) => pid),
						WAIT_MS,
					),
				).resolves.toStrictEqual([]);
				// The supervisor ended the session: it deleted its files.
				expect(sessionFilesLeft(fixture)).toStrictEqual([]);
			},
		);
	});
});
