/**
 * The reaper through its Node API, with real processes: lifecycle scenarios
 * L1, L4, L5, and L9 of spec #28, and `terminate` semantics. L2 (hard kill
 * of the host) runs end to end in `test/e2e/start.spec.ts`.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished } from "vitest";

import type { WorkerSpec } from "../../src/reaper/protocol.ts";
import type { Reaper } from "../../src/reaper/reaper-client.ts";
import { launchReaperAsync } from "../../src/reaper/reaper-client.ts";
import { nodeChildProcessRunner } from "../../src/seams/child-process.ts";
import { nodeClock } from "../../src/seams/clock.ts";
import { nodeHost } from "../../src/seams/host.ts";
import { loadRealNative, REAPER_PATH } from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";
import {
	isProcessAlive,
	killWorkers,
	readWorkerLog,
	waitForDeathAsync,
	waitForWorkersAsync,
} from "../helpers/worker-log.ts";

const FAKE_WORKER = path.join(import.meta.dirname, "..", "fixtures", "bin", "fake-worker.ts");
const native = loadRealNative();

interface TestSession {
	directory: string;
	leasePath: string;
	log: string;
	reaper: Reaper;
	sessionId: string;
	/** A long-running fake Rojo with these fixture variables. */
	worker: (id: string, variables?: Record<string, string>) => WorkerSpec;
}

/**
 * Start a real reaper in a temporary directory. The test's end kills it and
 * every fixture process it logged, whatever the test did.
 *
 * @returns The reaper and helpers for its workers.
 */
async function startSessionAsync(): Promise<TestSession> {
	const directory = makeTemporaryDirectory();
	const leasePath = path.join(directory, "workers.lock");
	const log = path.join(directory, "workers.ndjson");
	const sessionId = randomUUID();
	onTestFinished(() => {
		killWorkers(readWorkerLog(log));
	});
	const reaper = await launchReaperAsync(
		{
			childProcess: nodeChildProcessRunner,
			clock: nodeClock,
			host: nodeHost,
			native: () => native,
		},
		{ file: REAPER_PATH, leasePath, sessionId },
	);
	onTestFinished(async () => {
		if (isProcessAlive(reaper.pid)) {
			process.kill(reaper.pid, "SIGKILL");
		}

		await reaper.ended;
	});

	return {
		directory,
		leasePath,
		log,
		reaper,
		sessionId,
		worker: (id, variables = {}) => {
			return {
				id,
				args: [FAKE_WORKER, "rojo", "serve"],
				cwd: directory,
				env: { ...process.env, FIXTURE_LOG: log, ...variables },
				file: process.execPath,
			};
		},
	};
}

function pidsOf(log: string): Array<number> {
	return readWorkerLog(log).map(({ pid }) => pid);
}

describe("reaper", () => {
	it("should tag every worker and descendant with the session and worker ids", async () => {
		expect.assertions(1);

		const { log, reaper, sessionId, worker } = await startSessionAsync();
		reaper.go();
		await reaper.spawnAsync(worker("rojo", { FIXTURE_GRANDCHILDREN: "1" }));
		const records = await waitForWorkersAsync(log, 2);

		expect(records.map(({ markers }) => markers)).toStrictEqual([
			{ session: sessionId, worker: "rojo" },
			{ session: sessionId, worker: "rojo" },
		]);
	});

	it("should leave zero survivors after a graceful terminate (L1)", async () => {
		expect.assertions(3);

		const { log, reaper, worker } = await startSessionAsync();
		reaper.go();
		await reaper.spawnAsync(worker("rojo", { FIXTURE_GRANDCHILDREN: "2" }));
		await reaper.spawnAsync(worker("compiler", { FIXTURE_GRANDCHILDREN: "2" }));
		await waitForWorkersAsync(log, 6);
		const end = await reaper.terminateAsync(5000);

		expect(end.terminated).toBeTrue();
		expect(
			end.reports.map(({ id, report }) => ({ id, incomplete: report.incomplete })),
		).toIncludeSameMembers([
			{ id: "rojo", incomplete: false },
			{ id: "compiler", incomplete: false },
		]);
		await expect(waitForDeathAsync(pidsOf(log))).resolves.toStrictEqual([]);
	});

	it("should reject spawns after terminate, release the lease, and exit", async () => {
		expect.assertions(5);

		const { leasePath, log, reaper, worker } = await startSessionAsync();
		reaper.go();
		await reaper.spawnAsync(worker("rojo", { FIXTURE_IGNORE_SIGNALS: "1" }));
		await waitForWorkersAsync(log, 1);

		expect(native.tryLockFile(leasePath, "exclusive")).toBeNull();

		const ending = reaper.terminateAsync(1000);

		await expect(reaper.spawnAsync(worker("late"))).rejects.toMatchObject({
			code: "process_failed",
			details: { reason: "terminating" },
		});
		await expect(ending).resolves.toMatchObject({ terminated: true });
		expect(isProcessAlive(reaper.pid)).toBeFalse();
		expect(native.tryLockFile(leasePath, "exclusive")).not.toBeNull();
	});

	it("should force-kill a worker that ignores the graceful stop (L4)", async () => {
		expect.assertions(3);

		const { log, reaper, worker } = await startSessionAsync();
		reaper.go();
		const rojo = await reaper.spawnAsync(
			worker("rojo", { FIXTURE_GRANDCHILDREN: "1", FIXTURE_IGNORE_SIGNALS: "1" }),
		);
		await waitForWorkersAsync(log, 2);
		reaper.stop("rojo", 500);

		await expect(rojo.exited).resolves.toMatchObject({ forced: true, incomplete: false });
		await expect(waitForDeathAsync(pidsOf(log))).resolves.toStrictEqual([]);
		// The session still ends normally.
		await expect(reaper.terminateAsync(1000)).resolves.toMatchObject({ terminated: true });
	});

	it("should kill descendants spawned at startup when the reaper dies (L5)", async () => {
		expect.assertions(2);

		const { log, reaper, worker } = await startSessionAsync();
		reaper.go();
		await reaper.spawnAsync(worker("rojo", { FIXTURE_GRANDCHILDREN: "3" }));
		await waitForWorkersAsync(log, 4);
		process.kill(reaper.pid, "SIGKILL");

		await expect(reaper.ended).resolves.toMatchObject({ terminated: false });
		await expect(waitForDeathAsync(pidsOf(log))).resolves.toStrictEqual([]);
	});

	it("should leave nothing when the reaper dies right after it creates a worker (L9)", async () => {
		expect.assertions(1);

		const survivors: Array<number> = [];
		for (let round = 0; round < 10; round++) {
			const { reaper, worker } = await startSessionAsync();
			reaper.go();
			const spawned = await reaper.spawnAsync(worker(`rojo-${round}`));
			process.kill(reaper.pid, "SIGKILL");
			await reaper.ended;
			survivors.push(...(await waitForDeathAsync([spawned.pid])));
		}

		expect(survivors).toStrictEqual([]);
	}, 60_000);

	it("should reject a worker whose program does not exist", async () => {
		expect.assertions(1);

		const { directory, reaper, worker } = await startSessionAsync();
		reaper.go();

		await expect(
			reaper.spawnAsync({
				...worker("ghost"),
				file: path.join(directory, "no-such-program"),
			}),
		).rejects.toMatchObject({ code: "process_failed", details: { reason: "spawn_failed" } });
	});
});
