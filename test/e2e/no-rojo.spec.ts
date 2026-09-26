/**
 * `--no-rojo` as a real process: the agent loop with the compiler alone
 * (`up`, `status --wait`, `down`) on a busy Rojo port, and the usage error
 * for a session with no service.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { EXIT_SUCCESS, EXIT_USAGE } from "../../src/exit-codes.ts";
import type { WorkerRecord } from "../helpers/worker-log.ts";
import { readWorkerLog, waitForDeathAsync } from "../helpers/worker-log.ts";
import { holdPortAsync, makeFixtureAsync } from "./session-fixture.ts";
import { runForgeAsync } from "./up-fixture.ts";

/**
 * Every `rojo serve` a fixture log records.
 *
 * @param log - The fixture log.
 * @returns Their records, in start order.
 */
function rojoServes(log: string): Array<WorkerRecord> {
	return readWorkerLog(log).filter(({ args, role }) => role === "rojo" && args[0] === "serve");
}

describe("forge up --no-rojo", () => {
	it("should run the compiler alone on a busy Rojo port, through up, status --wait, and down", async () => {
		expect.assertions(5);

		const fixture = await makeFixtureAsync({ projectType: "rbxts" });
		await holdPortAsync(fixture.port);
		const watched = path.join(fixture.project, "src", "main.ts");
		mkdirSync(path.dirname(watched), { recursive: true });
		writeFileSync(watched, "export {};\n");
		const up = await runForgeAsync(fixture, ["up", "--no-open", "--no-rojo", "--json"], {
			FIXTURE_COMPILE_MS: "500",
			FIXTURE_COMPILER_WATCH: watched,
		});
		writeFileSync(watched, "export const error = 1;\n");
		const fresh = await runForgeAsync(fixture, ["status", "--json", "--wait"]);
		const down = await runForgeAsync(fixture, ["down", "--json"]);

		expect([up.status, fresh.status, down.status]).toStrictEqual([
			EXIT_SUCCESS,
			EXIT_SUCCESS,
			EXIT_SUCCESS,
		]);
		expect(up.result.data).toMatchObject({
			phase: "ready",
			services: {
				compiler: { lastBuild: { errors: 0 }, status: "ready" },
				rojo: { port: null, status: "off" },
			},
			started: true,
		});
		expect(fresh.result.data).toMatchObject({
			services: { compiler: { lastBuild: { errors: 1 } }, rojo: { status: "off" } },
		});
		expect(rojoServes(fixture.log)).toStrictEqual([]);
		await expect(
			waitForDeathAsync([Number(up.result.data!["pid"])], 10_000),
		).resolves.toStrictEqual([]);
	});

	it.for(["start", "up"])(
		"should fail %s with usage and exit 2 with --no-compiler too, starting nothing",
		async (command) => {
			expect.assertions(3);

			const fixture = await makeFixtureAsync();
			const run = await runForgeAsync(fixture, [
				command,
				"--no-open",
				"--no-compiler",
				"--no-rojo",
				"--json",
			]);

			expect(run.status).toBe(EXIT_USAGE);
			expect(run.result).toMatchObject({
				error: { code: "usage", message: "With --no-rojo, the session runs no service." },
				ok: false,
			});
			expect(readWorkerLog(fixture.log)).toStrictEqual([]);
		},
	);
});
