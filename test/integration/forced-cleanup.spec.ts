/**
 * The startup barrier and `--force` against an earlier session whose
 * processes outlive the bound: scenarios C4, C7, C8, and C15 of spec #28.
 * Each test stages the earlier session by hand (its directory and a real
 * reaper that keeps its lease, with no supervisor), as after its supervisor
 * died while its reaper hung. The bound is the 15 s margin (the graceful
 * stop time is 0).
 *
 * C9, a POSIX descendant that scrubs its environment and closes the lease,
 * leaves no evidence of its session: an accepted limit (ADR 0001).
 */
import assert from "node:assert/strict";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { ForgeError } from "../../src/errors.ts";
import type { CleanupReport } from "../../src/native/addon.ts";
import {
	isProcessAlive,
	readWorkerLog,
	waitForDeathAsync,
	waitForWorkersAsync,
} from "../helpers/worker-log.ts";
import type { Launched, Settled } from "./session-harness.ts";
import {
	filesLeft,
	launch,
	makeProjectAsync,
	native,
	ROJO_ONLY,
	settledWithinAsync,
	stageOldSessionAsync,
	waitForAsync,
} from "./session-harness.ts";

const FORCE = { ...ROJO_ONLY, force: true };
/** The barrier's bound, the cleanup, and the session's start. */
const FORCED_START_MS = 45_000;
/**
 * A refusal: the barrier's bound (15 s) and the supervisor's start. A
 * stop: its escalation (22 s) and the final barrier (5 s) at worst.
 */
const EXIT_MS = 30_000;
/**
 * A test's bound: every step's bound (a refusal, a forced start, a stop),
 * and the staging and the checks.
 */
const TEST_MS = EXIT_MS + FORCED_START_MS + EXIT_MS + 15_000;

/**
 * Wait until the forced session is ready, stop it, and return what its
 * cleanup of the earlier session did. A forced session that fails ends the
 * wait at once, with its error.
 *
 * @param run - The supervisor started with `--force`.
 * @returns The one cleanup it reports.
 */
async function forcedCleanupAsync(run: Launched): Promise<CleanupReport> {
	let early: Settled | undefined;
	void run.settled.then((settled) => {
		early = settled;
	});
	await waitForAsync(() => {
		return run.events.find(({ type }) => type === "info") ?? early;
	}, FORCED_START_MS);
	assert(
		early === undefined,
		`the forced session ended before it was ready: ${String(early?.ok === false ? early.error : "ok")}`,
	);
	run.stop("SIGINT");
	const settled = await settledWithinAsync(run, "stop the forced session", EXIT_MS);
	assert(settled.ok, `the forced session failed: ${String(settled.ok ? "" : settled.error)}`);
	const { cleanups } = settled.result.data;
	assert(Array.isArray(cleanups) && cleanups.length === 1, "expected one cleanup");
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the supervisor reports this shape
	return cleanups[0] as CleanupReport;
}

describe("forced cleanup", () => {
	it(
		"should refuse with the surviving PIDs, then kill the tree and the reaper last with --force (C4, C7, C8)",
		async () => {
			expect.assertions(5);

			const project = await makeProjectAsync();
			// Two detached grandchildren; on POSIX the first closes its lease
			// before it writes its record, and is found by its marker alone (C8).
			const old = await stageOldSessionAsync(project, [
				{
					FIXTURE_DETACH: "1",
					FIXTURE_GRANDCHILD_MODES: "close-lease",
					FIXTURE_GRANDCHILDREN: "2",
				},
			]);
			const records = await waitForWorkersAsync(project.log, 3);
			const workers = records.map(({ pid }) => pid);
			const refused = await settledWithinAsync(launch(project), "refuse", EXIT_MS);
			assert(!refused.ok && refused.error instanceof ForgeError, "expected a refusal");

			const { details } = refused.error;
			assert(details !== undefined);

			expect(refused.error).toMatchObject({
				code: "previous_generation_alive",
				details: { sessionId: old.sessionId },
			});
			expect(details["pids"]).toIncludeAllMembers([old.reaper.pid, ...workers]);

			const cleanup = await forcedCleanupAsync(launch(project, FORCE));

			expect(cleanup.killed.at(-1)).toBe(old.reaper.pid);
			expect(cleanup.killed).toIncludeAllMembers(workers);
			expect({
				files: filesLeft(project),
				survivors: await waitForDeathAsync([old.reaper.pid, ...workers]),
			}).toStrictEqual({ files: [], survivors: [] });
		},
		TEST_MS,
	);

	// Windows: the reaper's jobs kill every descendant when it dies.
	it.skipIf(process.platform === "win32")(
		"should find a scrubbed descendant that keeps the lease after the reaper died, and kill it (C15)",
		async () => {
			expect.assertions(4);

			const project = await makeProjectAsync();
			const old = await stageOldSessionAsync(project, [
				{
					FIXTURE_DETACH: "1",
					FIXTURE_GRANDCHILD_MODES: "scrub",
					FIXTURE_GRANDCHILDREN: "1",
				},
			]);
			const [, hidden] = await waitForWorkersAsync(project.log, 2);
			assert(hidden !== undefined);
			// Hard-kill the reaper; the test's reaper client then kills the
			// worker's group, which the scrubbed descendant has left.
			process.kill(old.reaper.pid, "SIGKILL");
			await old.reaper.ended;

			expect({ isAlive: isProcessAlive(hidden.pid), markers: hidden.markers }).toStrictEqual({
				isAlive: true,
				markers: {},
			});
			expect(
				native
					.scanSession({
						leasePath: `${old.directory}/workers.lock`,
						recordPath: `${old.directory}/reaper.json`,
						sessionId: old.sessionId,
					})
					.map(({ pid }) => pid),
			).toStrictEqual([hidden.pid]);

			const cleanup = await forcedCleanupAsync(launch(project, FORCE));

			expect(cleanup.killed).toStrictEqual([hidden.pid]);
			await expect(
				waitForDeathAsync(readWorkerLog(project.log).map(({ pid }) => pid)),
			).resolves.toStrictEqual([]);
		},
		TEST_MS,
	);
});
