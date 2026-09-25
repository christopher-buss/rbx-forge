/**
 * `forge start` as a real process, with fake Rojo, compiler, hook, and
 * Studio (`test/fixtures/bin/fake-worker.ts`) on PATH and the real reaper.
 * The process table is the oracle: every worker and grandchild must be gone.
 *
 * Real Roblox Studio never opens: the place is always the stand-in of
 * `open.spec.ts` (a batch file on Windows, where `start` picks the app by
 * file type), and the tests make and remove Studio's lock file themselves.
 */
import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { EXIT_FAILURE, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import { parseLines, parseResult } from "../helpers/output.ts";
import type { WorkerRecord } from "../helpers/worker-log.ts";
import {
	isProcessAlive,
	readWorkerLog,
	waitForDeathAsync,
	waitForWorkersAsync,
} from "../helpers/worker-log.ts";
import { runBinAsync } from "./run-bin.ts";
import {
	holdPortAsync,
	IS_WINDOWS,
	makeFixtureAsync,
	PLACE,
	ROJO_ONLY,
	startSession,
	waitForOutputAsync,
	waitForRoleAsync,
	WORKER_ROLES,
} from "./session-fixture.ts";

function workersOf(log: string): Array<WorkerRecord> {
	return readWorkerLog(log).filter(({ role }) => WORKER_ROLES.has(role));
}

function describeWorker({ args, role }: WorkerRecord): string {
	return [role, ...args].join(" ");
}

describe("forge start", () => {
	it("should run the whole workflow and leave zero survivors once Studio closes the place (W1)", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync({
			hooks: { syncback: { post: ["hook"] } },
			projectType: "rbxts",
		});
		const session = startSession(fixture, ["start", "--syncback", "--json"], {
			FIXTURE_GRANDCHILDREN: "1",
		});
		await waitForOutputAsync(session, "Press Ctrl+C to stop.");
		const studio = await waitForRoleAsync(fixture.log, "studio");
		writeFileSync(`${fixture.place}.lock`, `${studio.pid}\n`);
		await waitForOutputAsync(session, "The session ends when Studio closes it.");
		// Studio saves the place.
		const later = new Date(Date.now() + 60_000);
		utimesSync(fixture.place, later, later);
		await waitForRoleAsync(fixture.log, "hook");
		rmSync(`${fixture.place}.lock`);
		const status = await session.closed;
		const workers = workersOf(fixture.log);
		const sessions = new Set(workers.map(({ markers }) => markers.session));

		// Every worker, the hook included, is a worker of one session's reaper.
		expect({
			result: parseResult(session.stdout()),
			sessions: sessions.size,
			status,
		}).toMatchObject({
			result: { data: { reason: "studio_closed" } },
			sessions: 1,
			status: EXIT_SUCCESS,
		});
		// Rojo and the compiler start their processes at about the same time.
		expect(workers.map(describeWorker)).toIncludeSameMembers([
			"rojo syncback --help",
			"rbxtsc",
			`rojo build default.project.json --output ${PLACE}`,
			`rojo serve default.project.json --port ${fixture.port}`,
			"rbxtsc -w",
			`rojo syncback default.project.json --input ${PLACE} --non-interactive`,
			"hook",
		]);
		expect(parseLines(session.stdout())).toContainEqual({
			diagnostics: [],
			errors: 0,
			type: "compiled",
		});

		const others = readWorkerLog(fixture.log).filter(({ role }) => role !== "studio");

		// Every process is gone but Studio, which the session never owned.
		expect({
			isStudioAlive: isProcessAlive(studio.pid),
			survivors: await waitForDeathAsync(others.map(({ pid }) => pid)),
		}).toStrictEqual({ isStudioAlive: true, survivors: [] });
	});

	it("should run Rojo and the compiler without Studio with --no-open, and stop with service_failed:compiler when it exits", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync({ projectType: "rbxts" });
		const session = startSession(fixture, ["start", "--no-open", "--json"], {
			FIXTURE_EXIT_AFTER_MS: "3000",
			FIXTURE_EXIT_ROLE: "rbxtsc",
		});
		const status = await session.closed;

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(session.stdout()).error).toMatchObject({
			code: "service_failed",
			details: { reason: "service_failed:compiler" },
		});
		expect(readWorkerLog(fixture.log).map(({ role }) => role)).not.toContain("studio");
		await expect(
			waitForDeathAsync(readWorkerLog(fixture.log).map(({ pid }) => pid)),
		).resolves.toStrictEqual([]);
	});

	it("should kill a hook's whole tree when start is hard-killed while the hook runs", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync({
			hooks: { build: { pre: ["hook"] } },
			projectType: "rbxts",
		});
		const session = startSession(fixture, ["start", "--no-open", "--json"], {
			FIXTURE_GRANDCHILDREN: "2",
			FIXTURE_HANG: "1",
		});
		// The compile, then the hook and its two grandchildren.
		const records = await waitForWorkersAsync(fixture.log, 4, 30_000);
		session.child.kill("SIGKILL");
		await session.closed;
		const hook = records.filter(({ markers }) => markers.worker === "start-2");

		expect(hook.map(({ role }) => role)).toStrictEqual(["hook", "grandchild", "grandchild"]);
		await expect(waitForDeathAsync(records.map(({ pid }) => pid))).resolves.toStrictEqual([]);
	});
});

describe("forge start --no-open --no-compiler", () => {
	it("should serve on the fixed port and leave zero survivors when start is hard-killed (L2)", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		const session = startSession(fixture, ROJO_ONLY, { FIXTURE_GRANDCHILDREN: "2" });
		const records = await waitForWorkersAsync(fixture.log, 3, 30_000);
		// A hard kill: no handler in forge runs. Only the reaper's stdin EOF
		// is left to end the workers.
		session.child.kill("SIGKILL");
		await session.closed;

		expect(records[0]).toMatchObject({
			args: ["serve", "default.project.json", "--port", String(fixture.port)],
			role: "rojo",
		});
		expect(records.map(({ markers }) => markers.worker)).toStrictEqual([
			"rojo",
			"rojo",
			"rojo",
		]);
		await expect(waitForDeathAsync(records.map(({ pid }) => pid))).resolves.toStrictEqual([]);
	});

	it("should report ready once Rojo runs", async () => {
		expect.assertions(1);

		const fixture = await makeFixtureAsync();
		const session = startSession(fixture, ROJO_ONLY);
		await waitForOutputAsync(session, "Press Ctrl+C to stop.");

		expect(parseLines(session.stdout())).toStrictEqual([
			{ name: "rojo serve", status: "started", type: "step" },
			{ name: "rojo serve", status: "succeeded", type: "step" },
			{
				message: `Rojo serves default.project.json on port ${fixture.port}. Press Ctrl+C to stop.`,
				type: "info",
			},
		]);
	});

	// Windows cannot send SIGTERM to another process: `kill` terminates it.
	it.skipIf(IS_WINDOWS)("should stop every worker on SIGTERM and exit 0 (L1)", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		const session = startSession(fixture, ROJO_ONLY, { FIXTURE_GRANDCHILDREN: "2" });
		const records = await waitForWorkersAsync(fixture.log, 3, 30_000);
		session.child.kill("SIGTERM");
		const status = await session.closed;

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseResult(session.stdout()).data).toMatchObject({
			port: fixture.port,
			reason: "SIGTERM",
		});
		await expect(waitForDeathAsync(records.map(({ pid }) => pid))).resolves.toStrictEqual([]);
	});

	it("should stop the session with service_failed when Rojo exits, killing what it left", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		const session = startSession(fixture, ROJO_ONLY, {
			FIXTURE_EXIT_AFTER_MS: "1500",
			FIXTURE_EXIT_CODE: "3",
			FIXTURE_GRANDCHILDREN: "2",
		});
		const records = await waitForWorkersAsync(fixture.log, 3, 30_000);
		const status = await session.closed;

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(session.stdout()).error).toMatchObject({
			code: "service_failed",
			details: { reason: "service_failed:rojo" },
		});
		await expect(waitForDeathAsync(records.map(({ pid }) => pid))).resolves.toStrictEqual([]);
	});

	it("should fail with port_in_use when the fixed port is busy, starting nothing", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		await holdPortAsync(fixture.port);
		const { status, stdout } = await runBinAsync(
			ROJO_ONLY,
			fixture.project,
			fixture.environment(),
		);

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout).error!.code).toBe("port_in_use");
		expect(readWorkerLog(fixture.log)).toStrictEqual([]);
	});
});
