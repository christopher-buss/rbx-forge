/**
 * `forge down` as a real process against a session with fake Rojo, compiler,
 * and Studio, and the real reaper. Only NDJSON output, exit codes, files, and
 * the process table are checked.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { EXIT_CLEANUP_PENDING, EXIT_NOT_RUNNING, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import { parseStatus } from "../../src/session/status.ts";
import { openStudioStandInAsync, pidOf, waitForFileAsync } from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";
import {
	isProcessAlive,
	readWorkerLog,
	waitForDeathAsync,
	waitForWorkersAsync,
} from "../helpers/worker-log.ts";
import type { Fixture } from "./session-fixture.ts";
import {
	closedOnRequest,
	IS_MACOS,
	IS_WINDOWS,
	makeFixtureAsync,
	START_STUDIO,
	startReadyAsync,
} from "./session-fixture.ts";
import { runForgeAsync, UP, WATCH_COMMAND } from "./up-fixture.ts";

const DOWN = ["down", "--json"];
/** A session with no compiler: the open step builds the place first. */
const UP_STUDIO = ["up", "--no-compiler", "--studio", "--json"];
/** How long a dead process may stay a zombie before its parent reaps it. */
const REAP_MS = 2000;
/**
 * How forge ends a Studio behind a dialog: POSIX sees no dialog, so the time
 * limit.
 */
const BLOCKED_END = IS_WINDOWS ? "dialog" : "timeout";

/**
 * The AutoSaves folder the stand-in writes to, under a scratch home.
 *
 * @param home - `LOCALAPPDATA` (Windows) or `HOME` (macOS).
 * @returns The folder.
 */
function autoSavesUnder(home: string): string {
	const root = IS_WINDOWS ? home : path.join(home, "Library", "Application Support");
	return path.join(root, "Roblox", "RobloxStudio", "AutoSaves");
}

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
 * Start a session with `up --studio`, whose stand-in Studio has the place
 * open, and a second stand-in Studio with another place open.
 *
 * @param variables - Fixture variables for the session and its Studio.
 * @returns The fixture, the session id, the session's Studio PID, and the
 *   other Studio's PID.
 */
async function upWithStudioAsync(variables: Record<string, string> = {}): Promise<{
	fixture: Fixture;
	other: number;
	/** The PID the session recorded when it started Studio. */
	recorded: unknown;
	sessionId: unknown;
	studio: number;
}> {
	const fixture = await makeFixtureAsync({ open: { buildFirst: true } }, { studio: true });
	const other = await openStudioStandInAsync(path.join(fixture.project, "other.rbxl"));
	const { result } = await runForgeAsync(fixture, UP_STUDIO, variables);
	const status = parseStatus(result.data);
	const studio = readWorkerLog(fixture.log).find(({ role }) => role === "studio");
	return {
		fixture,
		other: pidOf(other),
		recorded: status?.services.studio.pid,
		sessionId: status?.sessionId,
		studio: studio!.pid,
	};
}

describe("forge down", () => {
	it("should close the session's Studio first, then stop the session, and touch no other Studio", async () => {
		expect.assertions(4);

		const { fixture, other, recorded, sessionId, studio } = await upWithStudioAsync();
		const down = await runForgeAsync(fixture, DOWN);

		// forge started the stand-in itself: its PID is the one the lock names.
		expect(recorded).toBe(studio);
		expect(down.result).toMatchObject({
			data: {
				sessionId,
				status: "stopped",
				// The session goes on without the Studio `up --studio` attached.
				stoppedBy: "shutdown",
				studio: closedOnRequest({ pid: studio, place: fixture.place, status: "closed" }),
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

	it("should end a Studio behind a dialog, without a save", async () => {
		expect.assertions(2);

		const { fixture, studio } = await upWithStudioAsync({ FIXTURE_STUDIO_CLOSE: "dialog" });
		const down = await runForgeAsync(fixture, DOWN);

		// POSIX has no dialog to see: the time limit ends Studio there.
		expect(down.result.data).toMatchObject({
			status: "stopped",
			studio: {
				end: BLOCKED_END,
				forced: true,
				pid: studio,
				status: "closed",
			},
		});
		expect({
			alive: await waitForDeathAsync([studio], REAP_MS),
			isOpen: existsSync(`${fixture.place}.lock`),
		}).toStrictEqual({ alive: [], isOpen: false });
	});

	it("should end a Studio at once once it closed the place, without its slow exit", async () => {
		expect.assertions(2);

		const { fixture, studio } = await upWithStudioAsync({ FIXTURE_STUDIO_CLOSE: "linger" });
		const down = await runForgeAsync(fixture, DOWN);

		expect(down.result.data).toMatchObject({
			studio: { end: "lock_released", forced: false, pid: studio, status: "closed" },
		});
		await expect(waitForDeathAsync([studio], REAP_MS)).resolves.toStrictEqual([]);
	});

	it("should keep the parts of a start session, its opening Studio too, and end nothing", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync({ open: { buildFirst: true } }, { studio: true });
		const { session } = await startReadyAsync(fixture, START_STUDIO, {
			FIXTURE_STUDIO_LOCK_DELAY_MS: "3000",
		});
		const down = await runForgeAsync(fixture, DOWN);

		expect(down.result.data).toMatchObject({
			parts: {
				kept: [
					{ owner: "start", part: "studio" },
					{ owner: "start", part: "rojo" },
				],
				stopped: [],
			},
			status: "running",
			studio: { status: "kept" },
		});
		expect(session.child.exitCode).toBeNull();
	});

	it.skipIf(!IS_WINDOWS && !IS_MACOS)(
		"should move the auto-recovery file of a Studio it ended into .forge/recovery",
		async () => {
			expect.assertions(2);

			const home = makeTemporaryDirectory();
			const { fixture } = await upWithStudioAsync({
				FIXTURE_STUDIO_AUTOSAVE: "1",
				FIXTURE_STUDIO_CLOSE: "dialog",
				HOME: home,
				LOCALAPPDATA: home,
			});
			const down = await runForgeAsync(fixture, DOWN, { HOME: home, LOCALAPPDATA: home });
			const saves = autoSavesUnder(home);

			expect(down.result.data).toMatchObject({
				studio: {
					recovery: {
						mode: "move",
						moved: [{ from: path.join(saves, "game_AutoRecovery_0.rbxl") }],
						warnings: [],
					},
				},
			});
			expect({
				left: readdirSync(saves),
				moved: readdirSync(path.join(fixture.project, ".forge", "recovery")).length,
			}).toStrictEqual({ left: [], moved: 2 });
		},
	);

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

		const fixture = await makeFixtureAsync(WATCH_COMMAND);
		const up = await runForgeAsync(fixture, UP, { FIXTURE_GRANDCHILDREN: "2" });
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
			data: {
				parts: { kept: [], stopped: ["compiler"] },
				sessionId,
				status: "stopped",
				stoppedBy: "shutdown",
			},
			ok: true,
		});
		expect(again.result.error!.code).toBe("not_running");
		expect({ alive, files: filesLeft(fixture.project) }).toStrictEqual({
			alive: [],
			files: [],
		});
	});

	it("should succeed and say so when the session has no part to stop", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync();
		const up = await runForgeAsync(fixture, ["up", "--no-compiler", "--json"]);
		const down = await runForgeAsync(fixture, DOWN);

		expect(down.result).toMatchObject({
			data: {
				parts: { kept: [], stopped: [] },
				sessionId: up.result.data!["sessionId"],
				status: "stopped",
				stoppedBy: "shutdown",
			},
			ok: true,
		});
		expect(filesLeft(fixture.project)).toStrictEqual([]);
	});

	it("should report a hung supervisor as unresponsive, then kill it with --force", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync(WATCH_COMMAND);
		const pauses = makeTemporaryDirectory();
		const up = await runForgeAsync(fixture, UP, {
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
