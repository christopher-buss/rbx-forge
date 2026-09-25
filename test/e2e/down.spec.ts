/**
 * `forge down` as a real process against a detached session with fake Rojo
 * and the real reaper. Only NDJSON output, exit codes, files, and the process
 * table are checked.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { EXIT_CLEANUP_PENDING, EXIT_NOT_RUNNING, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import { openStudioStandInAsync, pidOf, waitForFileAsync } from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";
import {
	isProcessAlive,
	readWorkerLog,
	waitForDeathAsync,
	waitForWorkersAsync,
} from "../helpers/worker-log.ts";
import type { Fixture } from "./session-fixture.ts";
import { makeFixtureAsync } from "./session-fixture.ts";
import { runForgeAsync, UP_ROJO_ONLY } from "./up-fixture.ts";

const DOWN = ["down", "--json"];
/** Rojo and Studio: the open step builds the place first. */
const UP_STUDIO = ["up", "--no-compiler", "--json"];
/** How long a dead process may stay a zombie before its parent reaps it. */
const REAP_MS = 2000;

/**
 * The session files left in the project.
 *
 * @param project - The project directory.
 * @returns `current` (when there) and every session id.
 */
function filesLeft(project: string): Array<string> {
	const forge = path.join(project, ".forge");
	const sessions = path.join(forge, "sessions");
	const current = existsSync(path.join(forge, "current")) ? ["current"] : [];
	return [...current, ...(existsSync(sessions) ? readdirSync(sessions) : [])];
}

/**
 * Wait until the session reports that Studio has its place open.
 *
 * @param fixture - The project.
 * @param sessionId - The session's id, from the `up` result.
 * @rejects When 30 seconds pass first.
 */
async function waitForStudioOpenAsync(fixture: Fixture, sessionId: unknown): Promise<void> {
	const state = path.join(fixture.project, ".forge", "sessions", String(sessionId), "state.json");
	const deadline = Date.now() + 30_000;
	while (!existsSync(state) || !readFileSync(state, "utf8").includes('"status":"open"')) {
		if (Date.now() > deadline) {
			throw new Error(`expected Studio open in ${state}`);
		}

		await sleep(50);
	}
}

/**
 * Start a detached session whose stand-in Studio has the place open, and a
 * second stand-in Studio with another place open.
 *
 * @param variables - Fixture variables for the session and its Studio.
 * @returns The fixture, the session id, the session's Studio PID, and the
 *   other Studio's PID.
 */
async function upWithStudioAsync(variables: Record<string, string> = {}): Promise<{
	fixture: Fixture;
	other: number;
	sessionId: unknown;
	studio: number;
}> {
	const fixture = await makeFixtureAsync({ open: { buildFirst: true } }, { studio: true });
	const other = await openStudioStandInAsync(path.join(fixture.project, "other.rbxl"));
	const up = await runForgeAsync(fixture, UP_STUDIO, variables);
	const { sessionId } = up.result.data!;
	await waitForStudioOpenAsync(fixture, sessionId);
	const studio = readWorkerLog(fixture.log).find(({ role }) => role === "studio");
	return { fixture, other: pidOf(other), sessionId, studio: studio!.pid };
}

describe("forge down", () => {
	it("should close the session's Studio first, then stop the session, and touch no other Studio", async () => {
		expect.assertions(3);

		const { fixture, other, sessionId, studio } = await upWithStudioAsync();
		const down = await runForgeAsync(fixture, DOWN);

		expect(down.result).toMatchObject({
			data: {
				sessionId,
				status: "stopped",
				stoppedBy: "studio_closed",
				studio: { forced: false, pid: studio, place: fixture.place, status: "closed" },
			},
			ok: true,
		});
		expect({
			alive: await waitForDeathAsync([studio], REAP_MS),
			isOpen: existsSync(`${fixture.place}.lock`),
		}).toStrictEqual({ alive: [], isOpen: false });
		expect({
			isOtherAlive: isProcessAlive(other),
			isOtherOpen: existsSync(path.join(fixture.project, "other.rbxl.lock")),
		}).toStrictEqual({ isOtherAlive: true, isOtherOpen: true });
	});

	it("should end a Studio that stays open after the close request, without a save", async () => {
		expect.assertions(2);

		const { fixture, studio } = await upWithStudioAsync({ FIXTURE_STUDIO_REFUSE_CLOSE: "1" });
		const down = await runForgeAsync(fixture, DOWN);

		expect(down.result.data).toMatchObject({
			status: "stopped",
			studio: { forced: true, pid: studio, status: "closed" },
		});
		expect({
			alive: await waitForDeathAsync([studio], REAP_MS),
			isOpen: existsSync(`${fixture.place}.lock`),
		}).toStrictEqual({ alive: [], isOpen: false });
	});

	it("should leave the session's Studio open with --keep-studio", async () => {
		expect.assertions(2);

		const { fixture, studio } = await upWithStudioAsync();
		const down = await runForgeAsync(fixture, [...DOWN, "--keep-studio"]);

		expect(down.result.data).toMatchObject({
			status: "stopped",
			stoppedBy: "shutdown",
			studio: { status: "kept" },
		});
		expect({
			isAlive: isProcessAlive(studio),
			isOpen: existsSync(`${fixture.place}.lock`),
		}).toStrictEqual({ isAlive: true, isOpen: true });
	});

	it("should stop a detached session and report stopped only once every process is gone", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync();
		const up = await runForgeAsync(fixture, UP_ROJO_ONLY, { FIXTURE_GRANDCHILDREN: "2" });
		const { pid, sessionId } = up.result.data!;
		const records = await waitForWorkersAsync(fixture.log, 3, 30_000);
		const workers = records.map((record) => record.pid);

		const down = await runForgeAsync(fixture, DOWN);
		// Dead already; on POSIX a zombie still answers a signal-0 probe
		// until its parent reaps it.
		const alive = await waitForDeathAsync([Number(pid), ...workers], REAP_MS);
		const again = await runForgeAsync(fixture, DOWN);

		expect([down.status, again.status]).toStrictEqual([EXIT_SUCCESS, EXIT_NOT_RUNNING]);
		expect(down.result).toMatchObject({
			data: { sessionId, status: "stopped", stoppedBy: "shutdown" },
			ok: true,
		});
		expect(again.result.error!.code).toBe("not_running");
		expect({ alive, files: filesLeft(fixture.project) }).toStrictEqual({
			alive: [],
			files: [],
		});
	});

	it("should report a hung supervisor as unresponsive, then kill it with --force", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync();
		const pauses = makeTemporaryDirectory();
		const up = await runForgeAsync(fixture, UP_ROJO_ONLY, {
			RBX_FORGE_TEST_PAUSE: "block",
			RBX_FORGE_TEST_PAUSE_DIR: pauses,
		});
		const pid = Number(up.result.data!["pid"]);
		const records = await waitForWorkersAsync(fixture.log, 1, 30_000);
		const workers = records.map((record) => record.pid);
		writeFileSync(path.join(pauses, "block.request"), "");
		await waitForFileAsync(path.join(pauses, "block.blocked"));

		const refused = await runForgeAsync(fixture, [...DOWN, "--timeout", "1"]);
		const isStillAlive = isProcessAlive(pid);
		const forced = await runForgeAsync(fixture, [...DOWN, "--force", "--timeout", "1"]);

		expect([refused.status, forced.status]).toStrictEqual([EXIT_CLEANUP_PENDING, EXIT_SUCCESS]);
		expect(refused.result.error).toMatchObject({
			code: "supervisor_unresponsive",
			details: { pid },
		});
		expect({ isStillAlive, stoppedBy: forced.result.data!["stoppedBy"] }).toStrictEqual({
			isStillAlive: true,
			stoppedBy: "killed",
		});
		await expect(waitForDeathAsync([pid, ...workers])).resolves.toStrictEqual([]);
	});

	it("should report not_running where no session ran", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync();
		const { result, status } = await runForgeAsync(fixture, DOWN);

		expect(status).toBe(EXIT_NOT_RUNNING);
		expect(result.error!.code).toBe("not_running");
	});
});
