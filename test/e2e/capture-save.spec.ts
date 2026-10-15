import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

import { captureRojo, makeCaptureModel } from "../helpers/capture-fixture.ts";
import { parseResult } from "../helpers/output.ts";
import { runBinAsync } from "./run-bin.ts";
import { makeFixtureAsync, START_STUDIO, startReadyAsync } from "./session-fixture.ts";

describe("forge save through the capture plugin", () => {
	it("captures through the Studio stand-in and syncs the assembled place back with genuine Rojo", async ({
		expect,
	}) => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync(
			{ studio: { saveMethod: "capture" } },
			{ studio: true },
		);
		mkdirSync(path.join(fixture.project, "src"));
		writeFileSync(
			path.join(fixture.project, "default.project.json"),
			JSON.stringify({
				name: "fixture",
				tree: {
					$className: "DataModel",
					Workspace: { $className: "Workspace", $path: "src" },
				},
			}),
		);
		const rojo = captureRojo();
		const variables = {
			FIXTURE_REAL_ROJO: rojo,
			FIXTURE_STUDIO_CAPTURE_MODEL: makeCaptureModel(fixture.project, rojo),
			FIXTURE_STUDIO_CAPTURE_ROJO_PORT: String(fixture.port),
			FIXTURE_STUDIO_CAPTURE_SERVICES: JSON.stringify([{ name: "Workspace", roots: [0] }]),
		};
		await startReadyAsync(fixture, START_STUDIO, variables);
		const saved = await runBinAsync(
			["save", "--timeout", "5", "--json"],
			fixture.project,
			fixture.environment(variables),
		);

		expect(parseResult(saved.stdout)).toMatchObject({
			command: "save",
			data: { place: fixture.place },
			ok: true,
		});

		const synced = await runBinAsync(
			["syncback", "--json"],
			fixture.project,
			fixture.environment(variables),
		);

		expect(parseResult(synced.stdout)).toMatchObject({ command: "syncback", ok: true });
		expect(
			readFileSync(path.join(fixture.project, "src/Edited/ChangedScript.luau"), "utf8"),
		).toBe("return 'captured edit'");
		expect(readdirSync(path.join(fixture.project, "src/Edited"))).toStrictEqual([
			"ChangedScript.luau",
			"NewPart.rbxm",
		]);
	});

	it("returns a bounded error when the stand-in receives a capture but does not post it", async ({
		expect,
	}) => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync(
			{ studio: { saveMethod: "capture" } },
			{ studio: true },
		);
		const variables = {
			FIXTURE_STUDIO_CAPTURE: "timeout",
			FIXTURE_STUDIO_CAPTURE_ROJO_PORT: String(fixture.port),
		};
		await startReadyAsync(fixture, START_STUDIO, variables);
		const saved = await runBinAsync(
			["save", "--timeout", "0.5", "--json"],
			fixture.project,
			fixture.environment(variables),
		);

		expect(saved.status).toBe(1);
		expect(parseResult(saved.stdout)).toMatchObject({
			command: "save",
			error: { code: "capture_timeout" },
			ok: false,
		});
	});
});
