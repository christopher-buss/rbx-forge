/**
 * `forge down` as a real process against a detached session with fake Rojo
 * and the real reaper (spec #28: stories 22 to 24; Testing: Sessions and
 * Forced stop). Only NDJSON output, exit codes, files, and the process
 * table are checked.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { EXIT_CLEANUP_PENDING, EXIT_NOT_RUNNING, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";
import { isProcessAlive, waitForDeathAsync, waitForWorkersAsync } from "../helpers/worker-log.ts";
import { makeFixtureAsync } from "./session-fixture.ts";
import { runForgeAsync, UP_ROJO_ONLY } from "./up-fixture.ts";

const DOWN = ["down", "--json"];

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
 * Wait until a file exists.
 *
 * @param file - Its absolute path.
 * @rejects When 30 seconds pass first.
 */
async function waitForFileAsync(file: string): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (!existsSync(file)) {
		if (Date.now() > deadline) {
			throw new Error(`expected ${file}`);
		}

		await sleep(50);
	}
}

describe("forge down", () => {
	it("should stop a detached session and report stopped only once every process is gone", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync();
		const up = await runForgeAsync(fixture, UP_ROJO_ONLY, { FIXTURE_GRANDCHILDREN: "2" });
		const { pid, sessionId } = up.result.data!;
		const records = await waitForWorkersAsync(fixture.log, 3, 30_000);
		const workers = records.map((record) => record.pid);

		const down = await runForgeAsync(fixture, DOWN);
		const alive = [Number(pid), ...workers].filter(isProcessAlive);
		const again = await runForgeAsync(fixture, DOWN);

		expect([down.status, again.status]).toStrictEqual([EXIT_SUCCESS, EXIT_NOT_RUNNING]);
		expect(down.result).toMatchObject({
			data: { sessionId, status: "stopped", stoppedBy: "shutdown" },
			ok: true,
		});
		expect(again.result.error!.code).toBe("not_running");
		expect({ alive, files: filesLeft(fixture.project) }).toStrictEqual({
			alive: [],
			files: [],
		});
	});

	it("should report a hung supervisor as unresponsive, then kill it with --force (F1)", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync();
		const pauses = makeTemporaryDirectory();
		const up = await runForgeAsync(fixture, UP_ROJO_ONLY, {
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
