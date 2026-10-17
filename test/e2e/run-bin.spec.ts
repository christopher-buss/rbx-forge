import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assert, describe, it } from "vitest";

import { pidOf, spawnSleeper } from "../helpers/real-native.ts";
import {
	isProcessAlive,
	readRecords,
	readWorkerLog,
	waitForDeathAsync,
} from "../helpers/worker-log.ts";
import { makeProject, runBinAsync } from "./run-bin.ts";
import { makeFixtureAsync } from "./session-fixture.ts";
import { runForgeAsync, stopDetachedAsync, UP, WATCH_COMMAND } from "./up-fixture.ts";

describe("built CLI subprocess diagnostics", () => {
	it("should report output and kill a stop CLI that stays alive after its result", async ({
		expect,
	}) => {
		expect.assertions(7);

		const project = makeProject({
			"rbx-forge.config.mjs": `
import { writeFileSync } from "node:fs";
writeFileSync("stop.pid", String(process.pid));
process.stdout.write("injected stop stdout\\n");
process.stderr.write("injected stop stderr\\n");
setInterval(() => {}, 60_000);
export default { projectType: "luau" };
`,
		});
		const started = Date.now();
		const failure: unknown = await runBinAsync(["stop", "--json"], project, undefined, {
			timeoutMs: 2000,
		}).catch((err: unknown) => err);
		assert(failure instanceof Error);

		expect(failure.message).toContain("stop --json");
		expect(failure.message).toContain(project);
		expect(failure.message).toContain("injected stop stdout");
		expect(failure.message).toContain("injected stop stderr");
		expect(failure.message).toContain('"command":"stop"');
		expect(Date.now() - started).toBeLessThan(5000);

		const pid = Number(readFileSync(path.join(project, "stop.pid"), "utf8"));

		expect(isProcessAlive(pid)).toBeFalse();
	}, 6000);

	it("should bound a stalled cleanup CLI and leave no session processes running", async ({
		expect,
	}) => {
		expect.assertions(8);

		const other = spawnSleeper();
		const fixture = await makeFixtureAsync(WATCH_COMMAND);
		const up = await runForgeAsync(fixture, UP);
		const supervisor = Number(up.result.data!["pid"]);
		const workers = readWorkerLog(fixture.log).map(({ pid }) => pid);
		const sessionId = String(up.result.data!["sessionId"]);
		const [reaper] = readRecords<{ pid: number }>(
			path.join(fixture.project, ".forge", "sessions", sessionId, "reaper.json"),
		);
		assert(reaper !== undefined);
		const config = readFileSync(path.join(fixture.project, "rbx-forge.config.json"), "utf8");
		writeFileSync(
			path.join(fixture.project, "rbx-forge.config.mjs"),
			`
import { writeFileSync } from "node:fs";
if (process.env["FIXTURE_HANG_DOWN"] === "1") {
	writeFileSync("down.pid", String(process.pid));
	process.stderr.write("injected cleanup stderr\\n");
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
export default ${config};
`,
		);
		const started = Date.now();
		const failure: unknown = await stopDetachedAsync(
			{
				...fixture,
				environment: () => fixture.environment({ FIXTURE_HANG_DOWN: "1" }),
			},
			2000,
		).catch((err: unknown) => err);
		assert(failure instanceof Error);

		expect(failure.message).toContain("down --force --json --timeout 5");
		expect(failure.message).toContain("injected cleanup stderr");
		expect(failure.message).toContain('"phase":"ready"');
		expect(failure.message).toContain('"status":"ready"');
		expect(Date.now() - started).toBeLessThan(9000);

		const down = Number(readFileSync(path.join(fixture.project, "down.pid"), "utf8"));

		expect(isProcessAlive(down)).toBeFalse();
		await expect(
			waitForDeathAsync([supervisor, reaper.pid, ...workers], 1000),
		).resolves.toStrictEqual([]);
		expect(isProcessAlive(pidOf(other))).toBeTrue();
	}, 15_000);
});
