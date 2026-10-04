import { fromAny } from "@total-typescript/shoehorn";

import { chmodSync } from "node:fs";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import { EXIT_FAILURE, EXIT_NOT_RUNNING } from "../../src/exit-codes.ts";
import { parseResult } from "../helpers/output.ts";
import { makeProject, runBinAsync } from "./run-bin.ts";
import { IS_WINDOWS, makeFixtureAsync, START_STUDIO, startReadyAsync } from "./session-fixture.ts";
import { runForgeAsync } from "./up-fixture.ts";

describe("forge show and hide", () => {
	it.for(["show", "hide"])(
		"returns studio_not_open for %s without a session",
		async (command) => {
			expect.assertions(2);

			const { status, stdout } = await runBinAsync([command, "--json"], makeProject());

			expect(status).toBe(EXIT_NOT_RUNNING);
			expect(parseResult(stdout)).toMatchObject({
				command,
				error: { code: "studio_not_open" },
				ok: false,
			});
		},
	);

	it.skipIf(!IS_WINDOWS).for(["show", "hide"])(
		"keeps the original Studio when %s cannot save its read-only place",
		async (command) => {
			expect.assertions(3);

			const fixture = await makeFixtureAsync(
				{ open: { buildFirst: true } },
				{ studio: true },
			);
			await startReadyAsync(fixture, START_STUDIO);
			const before = await runForgeAsync(fixture, ["status", "--json"]);
			chmodSync(fixture.place, 0o444);
			onTestFinished(() => {
				chmodSync(fixture.place, 0o666);
			});
			const moved = await runForgeAsync(fixture, [command, "--json"]);
			const after = await runForgeAsync(fixture, ["status", "--json"]);

			expect(moved.status).toBe(EXIT_FAILURE);
			expect(moved.result).toMatchObject({
				command,
				error: { code: "save_failed", details: { reason: "permission_denied" } },
				ok: false,
			});

			assert(before.result.data !== undefined, "status returns session data");

			const services: {
				rojo: unknown;
				studio: { desktop: unknown; owner: unknown; pid: number };
			} = fromAny(before.result.data["services"]);

			expect(after.result.data).toMatchObject({
				services: { rojo: services.rojo, studio: { ...services.studio, status: "open" } },
			});
		},
	);
});
