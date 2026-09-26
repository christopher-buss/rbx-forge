/**
 * `forge compile` as a real process while a detached session runs: it
 * reports the session's fresh build and never starts a second compiler.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { EXIT_FAILURE, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import { readWorkerLog } from "../helpers/worker-log.ts";
import type { Fixture } from "./session-fixture.ts";
import { makeFixtureAsync } from "./session-fixture.ts";
import { runForgeAsync } from "./up-fixture.ts";

function compilerRuns(fixture: Fixture): number {
	return readWorkerLog(fixture.log).filter(({ role }) => role === "rbxtsc").length;
}

async function watchedFixtureAsync(): Promise<{ fixture: Fixture; watched: string }> {
	const fixture = await makeFixtureAsync({ projectType: "rbxts" });
	const watched = path.join(fixture.project, "src", "main.ts");
	mkdirSync(path.dirname(watched), { recursive: true });
	writeFileSync(watched, "export {};\n");
	return { fixture, watched };
}

describe("forge compile with a running session", () => {
	it("should report the session's build of an edit and start no compiler", async () => {
		expect.assertions(5);

		const { fixture, watched } = await watchedFixtureAsync();
		const up = await runForgeAsync(fixture, ["up", "--no-open", "--json"], {
			FIXTURE_COMPILER_WATCH: watched,
		});
		const runs = compilerRuns(fixture);
		writeFileSync(watched, "export const error = 1;\n");
		const failed = await runForgeAsync(fixture, ["compile", "--json"]);
		writeFileSync(watched, "export {};\n");
		const fixed = await runForgeAsync(fixture, ["compile", "--json"]);

		expect(up.status).toBe(EXIT_SUCCESS);
		expect([failed.status, fixed.status]).toStrictEqual([EXIT_FAILURE, EXIT_SUCCESS]);
		expect(failed.result.error).toMatchObject({
			code: "compile_failed",
			details: {
				diagnostics: [expect.objectContaining({ line: 1, severity: "error" })],
				errors: 1,
				log: path.join(fixture.project, ".forge", "logs", "compiler.log"),
			},
		});
		expect(fixed.result.data).toMatchObject({ diagnostics: [], errors: 0, hooks: [] });
		expect(compilerRuns(fixture)).toBe(runs);
	});

	it("should fail with compiler_off when the session runs no compiler", async () => {
		expect.assertions(3);

		const { fixture } = await watchedFixtureAsync();
		await runForgeAsync(fixture, ["up", "--no-open", "--no-compiler", "--json"]);
		const compile = await runForgeAsync(fixture, ["compile", "--json"]);

		expect(compile.status).toBe(EXIT_FAILURE);
		expect(compile.result.error).toMatchObject({
			code: "compiler_off",
			details: { status: "off" },
			hint: 'Run "forge up" to start the compiler, then forge compile again.',
		});
		expect(compilerRuns(fixture)).toBe(0);
	});
});
