/**
 * `forge up`, `status`, and `logs` as real processes, with a fake compiler
 * on PATH and the real reaper. Every test stops the session it left and
 * waits until its supervisor is gone.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import { EXIT_NOT_RUNNING, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import type { SessionStatus } from "../../src/session/status.ts";
import { parseStatus } from "../../src/session/status.ts";
import { parseLines } from "../helpers/output.ts";
import { realNativePath } from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";
import {
	isProcessAlive,
	readWorkerLog,
	waitForDeathAsync,
	waitForWorkersAsync,
} from "../helpers/worker-log.ts";
import { BIN } from "./run-bin.ts";
import type { Fixture } from "./session-fixture.ts";
import { IS_WINDOWS, makeFixtureAsync } from "./session-fixture.ts";
import { runForgeAsync, stopDetachedAsync, UP, WATCH_COMMAND } from "./up-fixture.ts";

const IN_JOB = path.join(import.meta.dirname, "..", "fixtures", "bin", "in-job.ts");

/**
 * Every process the fixtures started, as `role args`.
 *
 * @param log - The fixture log.
 * @returns The process table, in start order.
 */
function processes(log: string): Array<string> {
	return readWorkerLog(log).map(({ args, role }) => [role, ...args].join(" "));
}

function compilers(log: string): number {
	return processes(log).filter((line) => line === "rbxtsc -w").length;
}

/**
 * Run `forge status --json` until the compiler's part has failed.
 *
 * @param fixture - The project and its environment.
 * @returns That status.
 * @rejects When 30 seconds pass first.
 */
async function waitForCompilerFailedAsync(fixture: Fixture): Promise<SessionStatus> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const { result } = await runForgeAsync(fixture, ["status", "--json"]);
		const status = parseStatus(result.data);
		if (status?.services.compiler.status === "failed") {
			return status;
		}

		assert(Date.now() < deadline, "the compiler never failed");
		await sleep(100);
	}
}

/**
 * Wait until `isDone` holds.
 *
 * @param isDone - The condition.
 * @rejects When 30 seconds pass first.
 */
async function waitForAsync(isDone: () => boolean): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (!isDone()) {
		if (Date.now() > deadline) {
			throw new Error("the condition never held");
		}

		await sleep(50);
	}
}

describe("forge up", () => {
	it("should start the compiler alone, and start nothing on a second up while it runs", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync(WATCH_COMMAND);
		const first = await runForgeAsync(fixture, UP);
		const second = await runForgeAsync(fixture, UP);
		const status = await runForgeAsync(fixture, ["status", "--json"]);

		expect([first.status, second.status, status.status]).toStrictEqual([
			EXIT_SUCCESS,
			EXIT_SUCCESS,
			EXIT_SUCCESS,
		]);
		expect(first.result).toMatchObject({
			data: {
				added: ["compiler"],
				phase: "ready",
				running: true,
				services: {
					compiler: { owner: null, status: "ready" },
					rojo: { status: "off" },
					studio: { status: "off" },
				},
				started: true,
			},
			ok: true,
		});
		expect(second.result.data).toMatchObject({
			added: [],
			sessionId: first.result.data!["sessionId"],
			started: false,
		});
		// No Rojo, no Studio, no build: one compiler in the process table.
		expect(processes(fixture.log)).toStrictEqual(["rbxtsc -w"]);
	});

	it("should keep the session up once the compiler exits, and start it again on a second up", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync(WATCH_COMMAND);
		const first = await runForgeAsync(fixture, UP, {
			FIXTURE_EXIT_AFTER_CODE: "3",
			FIXTURE_EXIT_AFTER_MS: "1500",
		});
		const failed = await waitForCompilerFailedAsync(fixture);
		const second = await runForgeAsync(fixture, UP);
		// A compiler is ready once it runs, maybe before it logs itself.
		await waitForWorkersAsync(fixture.log, 2);

		expect(first.status).toBe(EXIT_SUCCESS);
		expect(failed).toMatchObject({
			phase: "ready",
			running: true,
			services: { compiler: { exitCode: 3, owner: null, status: "failed" } },
		});
		expect(second.result).toMatchObject({
			data: {
				added: ["compiler"],
				services: { compiler: { status: "ready" } },
				sessionId: first.result.data!["sessionId"],
				started: false,
			},
			ok: true,
		});
		expect(compilers(fixture.log)).toBe(2);
	});

	it("should name no part in added when the compiler fails before its first build", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync({ projectType: "rbxts" });
		const watched = path.join(fixture.project, "src", "main.ts");
		mkdirSync(path.dirname(watched), { recursive: true });
		writeFileSync(watched, "export {};\n");
		const up = await runForgeAsync(fixture, UP, {
			FIXTURE_COMPILE_MS: "60000",
			FIXTURE_COMPILER_WATCH: watched,
			FIXTURE_EXIT_AFTER_CODE: "3",
			FIXTURE_EXIT_AFTER_MS: "1000",
		});

		expect(up.status).toBe(EXIT_SUCCESS);
		expect(up.result.data).toMatchObject({
			added: [],
			services: { compiler: { exitCode: 3, status: "failed" } },
			started: true,
		});
	});

	it("should start a session with no part in a project with no watch command", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync();
		const up = await runForgeAsync(fixture, UP);

		expect(up.result).toMatchObject({
			data: { added: [], phase: "ready", services: { compiler: { status: "off" } } },
			ok: true,
		});
		expect(processes(fixture.log)).toStrictEqual([]);
	});

	it("should outlive up, and stop every worker on shutdown", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync(WATCH_COMMAND);
		const up = await runForgeAsync(fixture, UP, { FIXTURE_GRANDCHILDREN: "2" });
		const pid = Number(up.result.data!["pid"]);
		// `up` has exited; its session runs on.
		const isAlive = isProcessAlive(pid);
		const records = await waitForWorkersAsync(fixture.log, 3, 30_000);
		await stopDetachedAsync(fixture);
		const workers = records.map(({ pid: worker }) => worker);

		expect(isAlive).toBeTrue();
		expect(workers).toHaveLength(3);
		await expect(waitForDeathAsync([pid, ...workers])).resolves.toStrictEqual([]);
	});

	it("should start one session when three ups run at once", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync(WATCH_COMMAND);
		const runs = await Promise.all([1, 2, 3].map(async () => runForgeAsync(fixture, UP)));
		const results = runs.map(({ result }) => result.data!);
		await waitForWorkersAsync(fixture.log, 1, 30_000);
		// A second compiler would have started by now.
		await sleep(1000);

		const sessions = new Set(results.map(({ sessionId }) => sessionId));

		expect(runs.map(({ status }) => status)).toStrictEqual([0, 0, 0]);
		expect(sessions.size).toBe(1);
		expect({
			compilers: compilers(fixture.log),
			started: results.filter(({ started }) => started === true).length,
		}).toStrictEqual({ compilers: 1, started: 1 });
	});

	it("should join a session that is starting", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync(WATCH_COMMAND);
		const pauses = makeTemporaryDirectory();
		const paused = path.join(pauses, "leased.paused");
		const first = runForgeAsync(fixture, UP, {
			RBX_FORGE_TEST_PAUSE: "leased",
			RBX_FORGE_TEST_PAUSE_DIR: pauses,
		});
		await waitForAsync(() => existsSync(paused));
		const second = runForgeAsync(fixture, UP);
		await sleep(1000);
		const compilersWhilePaused = compilers(fixture.log);
		rmSync(paused);
		const [one, two] = await Promise.all([first, second]);

		expect(compilersWhilePaused).toBe(0);
		expect([one.result.data!["started"], two.result.data!["started"]]).toStrictEqual([
			true,
			false,
		]);
		expect(two.result.data!["sessionId"]).toBe(one.result.data!["sessionId"]);
	});

	it("should report the session's startup failure", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync({ rojoPort: "not a port" });
		const { result, status } = await runForgeAsync(fixture, UP);

		expect(status).not.toBe(EXIT_SUCCESS);
		expect(result.error!.code).toBe("config_invalid");
	});

	it.skipIf(!IS_WINDOWS)(
		"should fail with detach_unsupported inside a job that forbids breakaway",
		async () => {
			expect.assertions(3);

			const fixture = await makeFixtureAsync(WATCH_COMMAND);
			const inJob = spawn(
				process.execPath,
				[IN_JOB, realNativePath(), "0", process.execPath, BIN, ...UP],
				{
					cwd: fixture.project,
					env: fixture.environment(),
					windowsHide: true,
				},
			);
			onTestFinished(() => {
				inJob.kill();
			});
			let stdout = "";
			inJob.stdout.setEncoding("utf8");
			inJob.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			const code = await new Promise((resolve) => {
				inJob.once("close", resolve);
			});

			expect(code).toBe(1);
			expect(parseLines(stdout).at(-1)).toMatchObject({
				error: { code: "detach_unsupported" },
			});
			expect(compilers(fixture.log)).toBe(0);
		},
	);
});

describe("forge status", () => {
	it("should fail with not_running when no session runs", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync();
		const { result, status } = await runForgeAsync(fixture, ["status", "--json"]);

		expect(status).toBe(EXIT_NOT_RUNNING);
		expect(result.error!.code).toBe("not_running");
	});
});

describe("forge logs", () => {
	it("should print a service's log, and follow new lines", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync(WATCH_COMMAND);
		await runForgeAsync(fixture, UP);
		const log = path.join(fixture.project, ".forge", "logs", "compiler.log");
		await sleep(500);
		const printed = await runForgeAsync(fixture, ["logs", "compiler", "--json"]);
		const follow = spawn(process.execPath, [BIN, "logs", "compiler", "--follow", "--json"], {
			cwd: fixture.project,
			env: fixture.environment(),
			windowsHide: true,
		});
		onTestFinished(() => {
			follow.kill();
		});
		let followed = "";
		follow.stdout.setEncoding("utf8");
		follow.stdout.on("data", (chunk: string) => {
			followed += chunk;
		});
		await sleep(1000);
		appendFileSync(log, "a new line\n");
		await waitForAsync(() => followed.includes("a new line"));

		expect(parseLines(printed.stdout)).toContainEqual({
			line: "Found 0 errors. Watching for file changes.",
			service: "compiler",
			type: "log",
		});
		expect(parseLines(followed)).toContainEqual({
			line: "a new line",
			service: "compiler",
			type: "log",
		});
	});
});
