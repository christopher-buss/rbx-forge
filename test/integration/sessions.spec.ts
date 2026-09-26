/**
 * Sessions of real supervisors, reapers, and fixture workers, and the
 * escalation of a hung reaper.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { assert, describe, expect, it } from "vitest";

import { isProcessAlive, waitForDeathAsync, waitForWorkersAsync } from "../helpers/worker-log.ts";
import {
	currentIdentity,
	filesLeft,
	launch,
	makeProjectAsync,
	native,
	ROJO_ONLY,
	waitForAsync,
	waitForReadyAsync,
	workersOf,
} from "./session-harness.ts";

interface Beat {
	at: number;
	pid: number;
	session?: string;
}

function readBeats(file: string): Array<Beat> {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fake-worker.ts writes this shape
			return JSON.parse(line) as unknown as Beat;
		});
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
 * Whether no one holds a lock on the file: take it exclusively, and let go.
 *
 * @param file - The file whose lock this probes.
 * @returns True when the lock was free.
 */
function isLockFree(file: string): boolean {
	const lock = native.tryLockFile(file, "exclusive");
	lock?.release();
	return lock !== null;
}

describe("sessions", () => {
	it("should stop gracefully with zero survivors and no escalation", async () => {
		expect.assertions(3);

		const project = await makeProjectAsync();
		const run = launch(project, ROJO_ONLY, { FIXTURE_GRANDCHILDREN: "2" });
		await waitForReadyAsync(run);
		const { pid, sessionId } = currentIdentity(project);
		run.stop("SIGINT");
		const settled = await run.settled;
		assert(settled.ok);

		expect(settled.result.data).not.toHaveProperty("escalation");
		expect(run.events.filter(({ type }) => type === "warning")).toStrictEqual([]);
		expect({
			files: filesLeft(project),
			survivors: await waitForDeathAsync([
				pid,
				...workersOf(project, sessionId).map((record) => record.pid),
			]),
		}).toStrictEqual({ files: [], survivors: [] });
	}, 60_000);

	it("should clean up a reaper that hangs at terminate by force, leaf first", async () => {
		expect.assertions(3);

		const project = await makeProjectAsync();
		const run = launch(project, ROJO_ONLY, {
			FIXTURE_GRANDCHILDREN: "2",
			RBX_FORGE_TEST_PAUSE: "reaper-stop",
		});
		await waitForReadyAsync(run);
		const { sessionId } = currentIdentity(project);
		run.stop("SIGINT");
		const reaper = await pausedPidAsync(path.join(project.pauses, "reaper-stop.paused"));
		const settled = await run.settled;
		assert(settled.ok);

		expect(settled.result.data).toMatchObject({
			escalation: "forced_cleanup",
			reason: "SIGINT",
		});
		expect(run.events).toContainEqual({
			message:
				"The reaper did not stop, even after its stdin closed; forge cleaned up the session by force.",
			type: "warning",
		});
		expect({
			files: filesLeft(project),
			survivors: await waitForDeathAsync([
				reaper,
				...workersOf(project, sessionId).map((record) => record.pid),
			]),
		}).toStrictEqual({ files: [], survivors: [] });
	}, 60_000);

	it("should keep the barrier blocked until the reaper has exited", async () => {
		expect.assertions(2);

		const project = await makeProjectAsync();
		const run = launch(project, ROJO_ONLY, { RBX_FORGE_TEST_PAUSE: "reaper-exit" });
		await waitForReadyAsync(run);
		const { sessionId } = currentIdentity(project);
		const directory = path.join(project.forge, "sessions", sessionId);
		run.stop("SIGINT");
		const pause = path.join(project.pauses, "reaper-exit.paused");
		const reaper = await pausedPidAsync(pause);
		const target = {
			leasePath: path.join(directory, "workers.lock"),
			recordPath: path.join(directory, "reaper.json"),
			sessionId,
		};
		const paused = {
			isLeaseFree: isLockFree(target.leasePath),
			isReaperAlive: isProcessAlive(reaper),
			scanned: native.scanSession(target).map(({ pid }) => pid),
		};
		rmSync(pause, { force: true });
		const settled = await run.settled;

		expect(paused).toStrictEqual({
			isLeaseFree: false,
			isReaperAlive: true,
			scanned: [reaper],
		});
		expect({ files: filesLeft(project), ok: settled.ok }).toStrictEqual({
			files: [],
			ok: true,
		});
	}, 60_000);

	it("should start a new session only once every worker of a hard-killed one is gone", async () => {
		expect.assertions(3);

		const project = await makeProjectAsync();
		const beats = path.join(project.project, "beats.ndjson");
		const variables = {
			FIXTURE_BEAT_LOG: beats,
			FIXTURE_BEAT_MS: "10",
			FIXTURE_GRANDCHILDREN: "2",
			FIXTURE_IGNORE_SIGNALS: "1",
		};
		const first = launch(project, ROJO_ONLY, variables);
		await waitForReadyAsync(first);
		const old = currentIdentity(project);
		await waitForWorkersAsync(project.log, 3);
		process.kill(old.pid, "SIGKILL");
		const second = launch(project, ROJO_ONLY, variables);
		await waitForReadyAsync(second);
		const next = currentIdentity(project);
		second.stop("SIGINT");
		const settled = await second.settled;
		const lastOldBeat = Math.max(
			...readBeats(beats)
				.filter(({ session }) => session === old.sessionId)
				.map(({ at }) => at),
		);
		const firstNewStart = Math.min(...workersOf(project, next.sessionId).map(({ at }) => at));

		expect(settled.ok).toBeTrue();
		expect(lastOldBeat).toBeLessThan(firstNewStart);
		await expect(
			waitForDeathAsync(workersOf(project, old.sessionId).map(({ pid }) => pid)),
		).resolves.toStrictEqual([]);
	}, 60_000);

	it("should never let a reaper paused before its lease spawn after its supervisor died", async () => {
		expect.assertions(3);

		const project = await makeProjectAsync();
		launch(project, ROJO_ONLY, { RBX_FORGE_TEST_PAUSE: "reaper-lease" });
		const pause = path.join(project.pauses, "reaper-lease.paused");
		const reaper = await pausedPidAsync(pause);
		const old = currentIdentity(project);
		process.kill(old.pid, "SIGKILL");
		const second = launch(project);
		await waitForReadyAsync(second);
		second.stop("SIGINT");
		const settled = await second.settled;
		rmSync(pause, { force: true });

		expect(settled.ok).toBeTrue();
		await expect(waitForDeathAsync([reaper])).resolves.toStrictEqual([]);
		expect({
			isOldAlive: isProcessAlive(old.pid),
			oldWorkers: workersOf(project, old.sessionId),
		}).toStrictEqual({ isOldAlive: false, oldWorkers: [] });
	}, 60_000);
});
