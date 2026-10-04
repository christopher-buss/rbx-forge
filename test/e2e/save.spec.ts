import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { EXIT_FAILURE, EXIT_NOT_RUNNING } from "../../src/exit-codes.ts";
import { parseResult } from "../helpers/output.ts";
import { makeProject, runBinAsync } from "./run-bin.ts";
import { makeFixtureAsync, START_STUDIO, startReadyAsync } from "./session-fixture.ts";

describe("forge save", () => {
	it("returns studio_not_open for a snapshot without a Studio, with no session", async () => {
		expect.assertions(2);

		const snapshot = ".forge/snapshots/example.rbxl";
		const project = makeProject();
		mkdirSync(path.join(project, ".forge", "snapshots"), { recursive: true });
		writeFileSync(path.join(project, snapshot), "snapshot");
		const { status, stdout } = await runBinAsync(
			["save", "--place", snapshot, "--json"],
			project,
		);

		expect(status).toBe(EXIT_NOT_RUNNING);
		expect(parseResult(stdout)).toMatchObject({
			command: "save",
			error: { code: "studio_not_open" },
			ok: false,
		});
	});

	it("returns the stable JSON error when no session Studio is open", async () => {
		expect.assertions(2);

		const { status, stdout } = await runBinAsync(["save", "--json"], makeProject());

		expect(status).toBe(EXIT_NOT_RUNNING);
		expect(parseResult(stdout)).toMatchObject({
			command: "save",
			error: { code: "studio_not_open" },
			ok: false,
			type: "result",
		});
	});

	it("refuses a read-only place before sending the stand-in Studio a save", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync({ open: { buildFirst: true } }, { studio: true });
		await startReadyAsync(fixture, START_STUDIO);
		chmodSync(fixture.place, 0o444);
		onTestFinished(() => {
			chmodSync(fixture.place, 0o666);
		});
		const { status, stdout } = await runBinAsync(
			["save", "--json"],
			fixture.project,
			fixture.environment(),
		);

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout)).toMatchObject({
			command: "save",
			error: {
				code: "save_failed",
				details: { place: fixture.place, reason: "permission_denied" },
			},
			ok: false,
			type: "result",
		});
	});
});
