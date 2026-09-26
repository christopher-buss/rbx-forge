/**
 * `forge status --wait` as a real process, against a detached session whose
 * fake roblox-ts compiler watches one file (`FIXTURE_COMPILER_WATCH`). The
 * test edits the file, then asks for the status at once: the answer must be
 * the build of the edit, not the one before it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { EXIT_SUCCESS } from "../../src/exit-codes.ts";
import type { SessionStatus } from "../../src/session/status.ts";
import { parseStatus } from "../../src/session/status.ts";
import { readWorkerLog } from "../helpers/worker-log.ts";
import { makeFixtureAsync } from "./session-fixture.ts";
import type { UpRun } from "./up-fixture.ts";
import { runForgeAsync } from "./up-fixture.ts";

function statusOf(run: UpRun): SessionStatus["services"]["compiler"] | undefined {
	return parseStatus(run.result.data)?.services.compiler;
}

describe("forge status --wait", () => {
	it.for([
		{ name: "one start line per compile", compileMs: "1500", ends: "1", starts: "1" },
		{
			name: "a second start line during the compile",
			compileMs: "500",
			ends: "2",
			starts: "2",
		},
		{ name: "two start lines of one compile", compileMs: "500", ends: "1", starts: "2" },
	])(
		"should return the build of the last edit with $name",
		async ({ compileMs, ends, starts }) => {
			expect.assertions(5);

			const fixture = await makeFixtureAsync({ projectType: "rbxts" });
			const watched = path.join(fixture.project, "src", "main.ts");
			mkdirSync(path.dirname(watched), { recursive: true });
			writeFileSync(watched, "export {};\n");
			const up = await runForgeAsync(fixture, ["up", "--json"], {
				FIXTURE_COMPILE_ENDS: ends,
				FIXTURE_COMPILE_MS: compileMs,
				FIXTURE_COMPILE_STARTS: starts,
				FIXTURE_COMPILER_WATCH: watched,
			});
			const editedAt = Date.now();
			writeFileSync(watched, "export const error = 1;\n");
			const fresh = await runForgeAsync(fixture, ["status", "--json", "--wait"]);
			const compiler = statusOf(fresh);

			// The compiler alone: no compile step, no build, no Rojo.
			expect({
				exits: [up.status, fresh.status],
				processes: readWorkerLog(fixture.log).map(
					({ args, role }) => `${role} ${args.join(" ")}`,
				),
			}).toStrictEqual({ exits: [EXIT_SUCCESS, EXIT_SUCCESS], processes: ["rbxtsc -w"] });
			expect(statusOf(up)!.lastBuild!.errors).toBe(0);
			expect(compiler).toMatchObject({ building: false, lastBuild: { errors: 1 } });
			expect(Date.parse(compiler!.lastBuild!.startedAt)).toBeGreaterThanOrEqual(editedAt);
			expect(Date.parse(compiler!.lastBuild!.at)).toBeGreaterThan(editedAt);
		},
	);

	it("should return the build of the last edit from sloptor's NDJSON events", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync({
			projectType: "rbxts",
			rbxts: { args: ["build", "--json"], command: "sloptor" },
		});
		const watched = path.join(fixture.project, "src", "main.ts");
		mkdirSync(path.dirname(watched), { recursive: true });
		writeFileSync(watched, "export {};\n");
		const up = await runForgeAsync(fixture, ["up", "--json"], {
			FIXTURE_COMPILE_MS: "500",
			FIXTURE_COMPILER_NDJSON: "1",
			FIXTURE_COMPILER_WATCH: watched,
		});
		const editedAt = Date.now();
		writeFileSync(watched, "export {};\nexport const error = 1;\n");
		const fresh = await runForgeAsync(fixture, ["status", "--json", "--wait"]);
		const compiler = statusOf(fresh);

		expect([up.status, fresh.status]).toStrictEqual([EXIT_SUCCESS, EXIT_SUCCESS]);
		expect(compiler).toMatchObject({
			building: false,
			lastBuild: {
				diagnostics: [
					{
						code: "TS2322",
						column: 1,
						file: "src/main.ts",
						line: 2,
						message: "Bad.",
						severity: "error",
					},
				],
				errors: 1,
			},
		});
		expect(Date.parse(compiler!.lastBuild!.startedAt)).toBeGreaterThanOrEqual(editedAt);
		expect(
			readWorkerLog(fixture.log)
				.filter(({ role }) => role === "sloptor")
				.map(({ args }) => args),
		).toContainEqual(["build", "--json", "-w"]);
	});

	it("should return the status at once with --timeout 0 while a compile runs", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync({ projectType: "rbxts" });
		const watched = path.join(fixture.project, "src", "main.ts");
		mkdirSync(path.dirname(watched), { recursive: true });
		writeFileSync(watched, "export {};\n");
		await runForgeAsync(fixture, ["up", "--json"], {
			FIXTURE_COMPILE_MS: "8000",
			FIXTURE_COMPILER_WATCH: watched,
		});
		writeFileSync(watched, "export const error = 1;\n");
		// The compile starts about 80 ms after the edit, and the session reads
		// its output every 250 ms; it then runs for 8 s.
		await sleep(1500);
		const now = await runForgeAsync(fixture, ["status", "--json", "--wait", "--timeout", "0"]);

		expect(now.status).toBe(EXIT_SUCCESS);
		expect(statusOf(now)).toMatchObject({ building: true, lastBuild: { errors: 0 } });
	});

	it("should return at once with the compiler off in a project with no watch command", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		const up = await runForgeAsync(fixture, ["up", "--json"]);
		const fresh = await runForgeAsync(fixture, ["status", "--json", "--wait"]);

		expect([up.status, fresh.status]).toStrictEqual([EXIT_SUCCESS, EXIT_SUCCESS]);
		expect(statusOf(fresh)).toStrictEqual({ building: false, owner: null, status: "off" });
		expect(readWorkerLog(fixture.log)).toStrictEqual([]);
	});
});
