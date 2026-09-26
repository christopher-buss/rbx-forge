/**
 * `forge sync` as a real process against a detached session, with fake Rojo
 * and hook on PATH and the real reaper. Syncback runs one at a time. Every
 * test stops the session it left.
 */
import { utimesSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { EXIT_NOT_RUNNING, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import type { WorkerRecord } from "../helpers/worker-log.ts";
import { readWorkerLog } from "../helpers/worker-log.ts";
import { makeFixtureAsync, waitForRoleAsync } from "./session-fixture.ts";
import { runForgeAsync, UP } from "./up-fixture.ts";

const HOOKED = { hooks: { syncback: { post: ["hook"] } } };
/** How long each fixture hook runs. */
const HOOK_MS = 1500;

function syncbackRuns(log: string): Array<WorkerRecord> {
	return readWorkerLog(log).filter(
		({ args, role }) => role === "rojo" && args[0] === "syncback" && !args.includes("--help"),
	);
}

describe("forge sync", () => {
	it("should run syncback and its hooks inside the running session", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync(HOOKED);
		writeFileSync(fixture.place, "place");
		const up = await runForgeAsync(fixture, UP);
		const sync = await runForgeAsync(fixture, ["sync", "--json"]);
		const status = await runForgeAsync(fixture, ["status", "--json"]);
		const { sessionId } = up.result.data!;
		const workers = readWorkerLog(fixture.log).filter(({ role }) => role !== "rojo");

		expect(sync.status).toBe(EXIT_SUCCESS);
		expect(sync.result.data).toMatchObject({
			hooks: [{ command: "hook", ok: true, outcome: "succeeded" }],
			input: fixture.place,
			project: "default.project.json",
		});
		// The hook ran as a worker of the session, not of `forge sync`.
		expect(
			workers.map(({ markers, role }) => ({ role, session: markers.session })),
		).toStrictEqual([{ role: "hook", session: sessionId }]);
		expect(status.result.data).toMatchObject({
			services: { syncback: { lastRun: { ok: true }, status: "off" } },
		});
	});

	it("should report not_running when no session runs", async () => {
		expect.assertions(1);

		const fixture = await makeFixtureAsync(HOOKED);
		const sync = await runForgeAsync(fixture, ["sync", "--json"]);

		expect({ code: sync.result.error!.code, status: sync.status }).toStrictEqual({
			code: "not_running",
			status: EXIT_NOT_RUNNING,
		});
	});

	it("should report the run's failure with its hook results", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync({
			hooks: { syncback: { post: ["no-such-hook"] } },
		});
		writeFileSync(fixture.place, "place");
		await runForgeAsync(fixture, UP);
		const sync = await runForgeAsync(fixture, ["sync", "--json"]);

		expect(sync.status).not.toBe(EXIT_SUCCESS);
		expect(sync.result.error).toMatchObject({
			code: "hook_failed",
			details: { hooks: [{ command: "no-such-hook", ok: false, outcome: "failed" }] },
		});
	});

	it("should wait for the save watch's run and its hooks, never running alongside them", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync(HOOKED);
		writeFileSync(fixture.place, "place");
		await runForgeAsync(fixture, [...UP, "--syncback"], {
			FIXTURE_HOOK_MS: String(HOOK_MS),
		});
		// Studio saves the place: the save watch starts a run.
		const later = new Date(Date.now() + 60_000);
		utimesSync(fixture.place, later, later);
		const watchHook = await waitForRoleAsync(fixture.log, "hook");
		const sync = await runForgeAsync(fixture, ["sync", "--json"]);
		const runs = syncbackRuns(fixture.log);

		expect(sync.status).toBe(EXIT_SUCCESS);
		expect(runs).toHaveLength(2);
		// The sync's Rojo started only once the watch run's hook had ended.
		expect(runs[1]!.at).toBeGreaterThanOrEqual(watchHook.at + HOOK_MS);
	});
});
