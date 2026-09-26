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
import { setTimeout as sleep } from "node:timers/promises";
import { assert, describe, expect, it } from "vitest";

import { EXIT_FAILURE, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import type { SessionStatus } from "../../src/session/status.ts";
import { parseStatus } from "../../src/session/status.ts";
import { parseLines, parseResult } from "../helpers/output.ts";
import type { WorkerRecord } from "../helpers/worker-log.ts";
import {
	isProcessAlive,
	readWorkerLog,
	waitForDeathAsync,
	waitForWorkersAsync,
} from "../helpers/worker-log.ts";
import { runBinAsync } from "./run-bin.ts";
import type { Fixture } from "./session-fixture.ts";
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

/**
 * The `rojo serve` worker in a fixture log.
 *
 * @param log - The fixture log.
 * @returns Its record.
 */
function rojoServe(log: string): WorkerRecord {
	const record = readWorkerLog(log).find(
		({ args, role }) => role === "rojo" && args[0] === "serve",
	);
	assert(record !== undefined, "Rojo never served");
	return record;
}

/**
 * Run `forge status --json` until `isDone` holds for the status.
 *
 * @param fixture - The project and its environment.
 * @param isDone - The condition.
 * @returns That status.
 * @rejects When 30 seconds pass first.
 */
async function waitForStatusAsync(
	fixture: Fixture,
	isDone: (status: SessionStatus) => boolean,
): Promise<SessionStatus> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const { stdout } = await runBinAsync(
			["status", "--json"],
			fixture.project,
			fixture.environment(),
		);
		const status = parseStatus(parseResult(stdout).data);
		if (status !== undefined && isDone(status)) {
			return status;
		}

		assert(Date.now() < deadline, "the status never came");
		await sleep(100);
	}
}

function describeWorker({ args, role }: WorkerRecord): string {
	return [role, ...args].join(" ");
}

describe("forge start", () => {
	it("should run the whole workflow, go on when its Studio closes, and leave zero survivors once killed", async () => {
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
		await waitForOutputAsync(session, "Roblox Studio has ");
		// Studio saves the place.
		const later = new Date(Date.now() + 60_000);
		utimesSync(fixture.place, later, later);
		await waitForRoleAsync(fixture.log, "hook");
		rmSync(`${fixture.place}.lock`);
		// The close of the Studio start owns stops nothing: start decides.
		const closed = await waitForStatusAsync(fixture, ({ services }) => {
			return services.studio.status === "closed";
		});
		session.child.kill("SIGKILL");
		await session.closed;
		const workers = workersOf(fixture.log);
		const sessions = new Set(workers.map(({ markers }) => markers.session));

		// Every worker, the hook included, is a worker of one session's reaper.
		expect({ services: closed.services, sessions: sessions.size }).toMatchObject({
			services: {
				compiler: { owner: "start", status: "ready" },
				rojo: { owner: "start", status: "ready" },
				studio: { owner: "start", status: "closed" },
			},
			sessions: 1,
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

	it("should run Rojo and the compiler without Studio with --no-open, and keep Rojo when the compiler exits", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync({ projectType: "rbxts" });
		const session = startSession(fixture, ["start", "--no-open", "--json"], {
			FIXTURE_EXIT_AFTER_MS: "3000",
			FIXTURE_EXIT_ROLE: "rbxtsc",
		});
		await waitForOutputAsync(session, "compiler exited (exit code 0)");
		const rojo = rojoServe(fixture.log);

		expect({
			isRojoAlive: isProcessAlive(rojo.pid),
			isRunning: session.child.exitCode === null,
		}).toStrictEqual({ isRojoAlive: true, isRunning: true });
		expect(readWorkerLog(fixture.log).map(({ role }) => role)).not.toContain("studio");

		session.child.kill("SIGKILL");
		await session.closed;

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
	it("should serve on the fixed port and leave zero survivors when start is hard-killed", async () => {
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
	it.skipIf(IS_WINDOWS)("should stop every worker on SIGTERM and exit 0", async () => {
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

	it("should fail only Rojo's part when it exits, killing what it left, and keep the session", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		const session = startSession(fixture, ROJO_ONLY, {
			FIXTURE_EXIT_AFTER_MS: "1500",
			FIXTURE_EXIT_CODE: "3",
			FIXTURE_GRANDCHILDREN: "2",
		});
		const records = await waitForWorkersAsync(fixture.log, 3, 30_000);
		await waitForOutputAsync(session, "rojo exited (exit code 3)");
		const survivors = await waitForDeathAsync(records.map(({ pid }) => pid));
		const { exitCode } = session.child;
		session.child.kill("SIGKILL");
		await session.closed;

		expect(survivors).toStrictEqual([]);
		expect(exitCode).toBeNull();
		expect(session.stdout()).toContain(
			"rojo exited (exit code 3); the session goes on without it.",
		);
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
