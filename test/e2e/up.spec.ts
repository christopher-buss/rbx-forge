/**
 * `forge up`, `status`, and `logs` as real processes, with fake Rojo and
 * compiler on PATH and the real reaper (spec #28, Detached sessions and
 * agents; Testing: Sessions C1, C2). Every test stops the session it left
 * and waits until its supervisor is gone.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";

import { EXIT_NOT_RUNNING, EXIT_SUCCESS } from "../../src/exit-codes.ts";
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
import { IS_WINDOWS, makeFixtureAsync } from "./session-fixture.ts";
import { runForgeAsync, stopDetachedAsync, UP_ROJO_ONLY } from "./up-fixture.ts";

const IN_JOB = path.join(import.meta.dirname, "..", "fixtures", "bin", "in-job.ts");

function rojoServes(log: string): number {
	return readWorkerLog(log).filter(({ args, role }) => role === "rojo" && args[0] === "serve")
		.length;
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
	it("should start a detached session, report it on a second up, and serve its status", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync();
		const first = await runForgeAsync(fixture, UP_ROJO_ONLY);
		const second = await runForgeAsync(fixture, UP_ROJO_ONLY);
		const status = await runForgeAsync(fixture, ["status", "--json"]);

		expect([first.status, second.status, status.status]).toStrictEqual([
			EXIT_SUCCESS,
			EXIT_SUCCESS,
			EXIT_SUCCESS,
		]);
		expect(first.result.data).toMatchObject({
			phase: "ready",
			running: true,
			services: { rojo: { port: fixture.port, status: "ready" } },
			started: true,
		});
		expect(second.result.data).toMatchObject({
			sessionId: first.result.data!["sessionId"],
			started: false,
		});
		expect(status.result.data).toMatchObject({
			services: {
				compiler: { status: "off" },
				rojo: { port: fixture.port, status: "ready" },
				studio: { status: "off" },
				syncback: { status: "off" },
			},
			sessionId: first.result.data!["sessionId"],
		});
	});

	it("should outlive up, and stop every worker on shutdown", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		const up = await runForgeAsync(fixture, UP_ROJO_ONLY, { FIXTURE_GRANDCHILDREN: "2" });
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

	it("should start one session when three ups run at once (C1)", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		const runs = await Promise.all(
			[1, 2, 3].map(async () => runForgeAsync(fixture, UP_ROJO_ONLY)),
		);
		const results = runs.map(({ result }) => result.data!);
		await waitForWorkersAsync(fixture.log, 1, 30_000);
		// A second Rojo would have started by now.
		await sleep(1000);

		const sessions = new Set(results.map(({ sessionId }) => sessionId));

		expect(runs.map(({ status }) => status)).toStrictEqual([0, 0, 0]);
		expect(sessions.size).toBe(1);
		expect({
			serves: rojoServes(fixture.log),
			started: results.filter(({ started }) => started === true).length,
		}).toStrictEqual({ serves: 1, started: 1 });
	});

	it("should join a session that is starting (C2)", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		const pauses = makeTemporaryDirectory();
		const paused = path.join(pauses, "leased.paused");
		const first = runForgeAsync(fixture, UP_ROJO_ONLY, {
			RBX_FORGE_TEST_PAUSE: "leased",
			RBX_FORGE_TEST_PAUSE_DIR: pauses,
		});
		await waitForAsync(() => existsSync(paused));
		const second = runForgeAsync(fixture, UP_ROJO_ONLY);
		await sleep(1000);
		const servesWhilePaused = rojoServes(fixture.log);
		rmSync(paused);
		const [one, two] = await Promise.all([first, second]);

		expect(servesWhilePaused).toBe(0);
		expect([one.result.data!["started"], two.result.data!["started"]]).toStrictEqual([
			true,
			false,
		]);
		expect(two.result.data!["sessionId"]).toBe(one.result.data!["sessionId"]);
	});

	it("should report the session's startup failure", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync({ rojoPort: "not a port" });
		const { result, status } = await runForgeAsync(fixture, UP_ROJO_ONLY);

		expect(status).not.toBe(EXIT_SUCCESS);
		expect(result.error!.code).toBe("config_invalid");
	});

	it.skipIf(!IS_WINDOWS)(
		"should fail with detach_unsupported inside a job that forbids breakaway",
		async () => {
			expect.assertions(3);

			const fixture = await makeFixtureAsync();
			const inJob = spawn(
				process.execPath,
				[IN_JOB, realNativePath(), "0", process.execPath, BIN, ...UP_ROJO_ONLY],
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
			expect(rojoServes(fixture.log)).toBe(0);
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

		const fixture = await makeFixtureAsync();
		await runForgeAsync(fixture, UP_ROJO_ONLY);
		const log = path.join(fixture.project, ".forge", "logs", "rojo.log");
		await sleep(500);
		const printed = await runForgeAsync(fixture, ["logs", "rojo", "--json"]);
		const follow = spawn(process.execPath, [BIN, "logs", "rojo", "--follow", "--json"], {
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
			line: "Rojo server listening",
			service: "rojo",
			type: "log",
		});
		expect(parseLines(followed)).toContainEqual({
			line: "a new line",
			service: "rojo",
			type: "log",
		});
	});
});
