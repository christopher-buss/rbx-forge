/**
 * `forge restart` as a real process: it restarts the parts of an `up`
 * session and of a `start` session through the real reaper, with the Studio
 * stand-in and fake Rojo. Only NDJSON output, exit codes, files, and the
 * process table are checked.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { assert, describe, expect, it } from "vitest";

import { EXIT_NOT_RUNNING, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import type { SessionStatus } from "../../src/session/status.ts";
import { parseStatus } from "../../src/session/status.ts";
import type { WorkerRecord } from "../helpers/worker-log.ts";
import { isProcessAlive, readWorkerLog, waitForDeathAsync } from "../helpers/worker-log.ts";
import type { Fixture } from "./session-fixture.ts";
import { makeFixtureAsync, startReadyAsync } from "./session-fixture.ts";
import type { UpRun } from "./up-fixture.ts";
import { runForgeAsync, WATCH_COMMAND } from "./up-fixture.ts";

/** A Luau project whose compiler runs in watch mode. */
const PROJECT = { ...WATCH_COMMAND, open: { buildFirst: true } };
const UP_STUDIO = ["up", "--studio", "--json"];
const RESTART = ["restart", "--json"];
/** How long a dead process may stay a zombie before its parent reaps it. */
const REAP_MS = 5000;

/**
 * The long-running fixture processes of each part, in start order.
 *
 * @param fixture - The project.
 * @returns The compiler, Rojo (not its builds), and Studio records.
 */
function partsOf(fixture: Fixture): Record<"compiler" | "rojo" | "studio", Array<WorkerRecord>> {
	const records = readWorkerLog(fixture.log);
	return {
		compiler: records.filter(({ role }) => role === "rbxtsc"),
		rojo: records.filter(({ args, role }) => role === "rojo" && args[0] === "serve"),
		studio: records.filter(({ role }) => role === "studio"),
	};
}

function pids(records: ReadonlyArray<WorkerRecord>): Array<number> {
	return records.map(({ pid }) => pid);
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
		const { result } = await runForgeAsync(fixture, ["status", "--json"]);
		const status = parseStatus(result.data);
		if (status !== undefined && isDone(status)) {
			return status;
		}

		assert(Date.now() < deadline, "the status never came");
		await sleep(100);
	}
}

function statusOf({ result }: UpRun): SessionStatus {
	const status = parseStatus(result.data);
	assert(status !== undefined, "expected a status");
	return status;
}

function ownersOf({ services }: SessionStatus): Record<string, unknown> {
	return {
		compiler: [services.compiler.owner, services.compiler.status],
		rojo: [services.rojo.owner, services.rojo.status],
		studio: [services.studio.owner, services.studio.status],
	};
}

describe("forge restart", () => {
	it("should restart the compiler, Rojo on the same port, and a fresh Studio once the old ones are gone", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync(PROJECT, { studio: true });
		await runForgeAsync(fixture, UP_STUDIO);
		const old = partsOf(fixture);
		const restart = await runForgeAsync(fixture, RESTART);
		const now = partsOf(fixture);

		expect([restart.status, restart.result.data]).toMatchObject([
			EXIT_SUCCESS,
			{
				added: ["compiler", "studio", "rojo"],
				kept: [],
				services: {
					compiler: { owner: null, status: "ready" },
					rojo: { owner: null, port: fixture.port, status: "ready" },
					studio: {
						owner: null,
						pid: now.studio[1]!.pid,
						place: fixture.place,
						status: "open",
					},
				},
				stopped: ["studio", "rojo", "compiler"],
				studio: {
					forced: false,
					pid: old.studio[0]!.pid,
					place: fixture.place,
					status: "closed",
				},
			},
		]);
		expect({
			compiler: now.compiler.length,
			rojo: now.rojo.map(({ args }) => args.join(" ")),
			studio: now.studio.length,
		}).toStrictEqual({
			compiler: 2,
			rojo: [
				`serve default.project.json --port ${fixture.port}`,
				`serve default.project.json --port ${fixture.port}`,
			],
			studio: 2,
		});
		await expect(
			waitForDeathAsync(
				[...pids(old.compiler), ...pids(old.rojo), ...pids(old.studio)],
				REAP_MS,
			),
		).resolves.toStrictEqual([]);
		expect(
			[now.compiler[1]!, now.rojo[1]!, now.studio[1]!].map(({ pid }) => isProcessAlive(pid)),
		).toStrictEqual([true, true, true]);
	});

	it("should leave the parts a start terminal owns alone, and name them", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync(PROJECT, { studio: true });
		await startReadyAsync(fixture, ["start", "--json"]);
		await waitForStatusAsync(fixture, ({ services }) => services.studio.status === "open");
		const old = partsOf(fixture);
		const restart = await runForgeAsync(fixture, RESTART);

		expect([restart.status, restart.result.data]).toMatchObject([
			EXIT_SUCCESS,
			{
				added: [],
				kept: [
					{ owner: "start", part: "studio" },
					{ owner: "start", part: "rojo" },
					{ owner: "start", part: "compiler" },
				],
				stopped: [],
			},
		]);
		expect(partsOf(fixture)).toStrictEqual(old);
	});

	it("should restart the parts a start terminal owns with --force, and keep their owner", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync(PROJECT, { studio: true });
		const { session } = await startReadyAsync(fixture, ["start", "--json"]);
		await waitForStatusAsync(fixture, ({ services }) => services.studio.status === "open");
		const old = partsOf(fixture);
		const restart = await runForgeAsync(fixture, ["restart", "--force", "--json"]);

		expect([restart.status, restart.result.data]).toMatchObject([
			EXIT_SUCCESS,
			{
				added: ["compiler", "studio", "rojo"],
				kept: [],
				stopped: ["studio", "rojo", "compiler"],
			},
		]);
		expect({
			owners: ownersOf(statusOf(restart)),
			start: session.child.exitCode,
		}).toStrictEqual({
			owners: {
				compiler: ["start", "ready"],
				rojo: ["start", "ready"],
				studio: ["start", "open"],
			},
			start: null,
		});
		await expect(
			waitForDeathAsync(
				[...pids(old.compiler), ...pids(old.rojo), ...pids(old.studio)],
				REAP_MS,
			),
		).resolves.toStrictEqual([]);
	});

	it("should compile fully after a deleted output folder, then start Rojo", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync(
			{ open: { buildFirst: true }, projectType: "rbxts" },
			{ studio: true },
		);
		const watched = path.join(fixture.project, "src", "main.ts");
		mkdirSync(path.dirname(watched), { recursive: true });
		writeFileSync(watched, "export {};\n");
		await runForgeAsync(fixture, UP_STUDIO, {
			FIXTURE_COMPILE_MS: "1500",
			FIXTURE_COMPILER_WATCH: watched,
		});
		rmSync(path.join(fixture.project, "out"), { force: true, recursive: true });
		const restart = await runForgeAsync(fixture, RESTART);
		const { compiler, rojo } = partsOf(fixture);
		const { lastBuild } = statusOf(restart).services.compiler;
		assert(lastBuild !== undefined, "expected a build");

		expect([restart.status, restart.result.data]).toMatchObject([
			EXIT_SUCCESS,
			{ added: ["compiler", "studio", "rojo"], stopped: ["studio", "rojo", "compiler"] },
		]);
		// The new compiler's first build started after it did, and ended
		// before Rojo started.
		expect(Date.parse(lastBuild.startedAt)).toBeGreaterThanOrEqual(compiler[1]!.at);
		expect(rojo[1]!.at).toBeGreaterThanOrEqual(Date.parse(lastBuild.at));
	});

	it("should fail with not_running when no session runs", async () => {
		expect.assertions(1);

		const fixture = await makeFixtureAsync(PROJECT);
		const restart = await runForgeAsync(fixture, RESTART);

		expect([restart.status, restart.result.error]).toMatchObject([
			EXIT_NOT_RUNNING,
			{ code: "not_running" },
		]);
	});
});
