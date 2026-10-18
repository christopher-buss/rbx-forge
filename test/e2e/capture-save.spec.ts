import { type } from "arktype";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assert, describe, it } from "vitest";

import { captureRojo, makeCaptureModel } from "../helpers/capture-fixture.ts";
import { parseOpened, parseResult } from "../helpers/output.ts";
import { waitForFileAsync } from "../helpers/real-native.ts";
import { runBinAsync } from "./run-bin.ts";
import {
	holdPortAsync,
	makeFixtureAsync,
	START_STUDIO,
	startReadyAsync,
} from "./session-fixture.ts";

describe("forge save through the capture plugin", () => {
	it("reports an unsupported captured-child attribute in CLI JSON and preserves the place", async ({
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
		const variables = {
			FIXTURE_REAL_ROJO: captureRojo(),
			FIXTURE_STUDIO_CAPTURE_MODEL: path.join(
				import.meta.dirname,
				"../fixtures/models/reference-attribute.rbxm",
			),
			FIXTURE_STUDIO_CAPTURE_ROJO_PORT: String(fixture.port),
			FIXTURE_STUDIO_CAPTURE_SERVICES: JSON.stringify([{ name: "Workspace", roots: [0, 1] }]),
		};
		await startReadyAsync(fixture, START_STUDIO, variables);
		const original = readFileSync(fixture.place);
		const saved = await runBinAsync(
			["save", "--timeout", "5", "--json"],
			fixture.project,
			fixture.environment(variables),
		);
		const result = parseResult(saved.stdout);

		expect(saved.status).toBe(1);
		expect(result).toMatchObject({
			command: "save",
			error: { code: "capture_assembly_failed" },
			ok: false,
		});

		assert(result.error !== undefined);
		assert(result.error.details !== undefined);

		expect(result.error.details["message"]).toContain(
			"ForgeReferenceAttributeFixture.Attributes",
		);
		expect(readFileSync(fixture.place)).toStrictEqual(original);
	});

	it("reports a named plugin failure in CLI JSON and preserves the existing place", async ({
		expect,
	}) => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync(
			{ studio: { saveMethod: "capture" } },
			{ studio: true },
		);
		const message = "Lighting attribute Reference: unsupported capture value InstanceHandle";
		const variables = {
			FIXTURE_STUDIO_CAPTURE_ERROR: JSON.stringify({ error: "serialize_failed", message }),
			FIXTURE_STUDIO_CAPTURE_ROJO_PORT: String(fixture.port),
		};
		await startReadyAsync(fixture, START_STUDIO, variables);
		const original = readFileSync(fixture.place);
		const saved = await runBinAsync(
			["save", "--timeout", "5", "--json"],
			fixture.project,
			fixture.environment(variables),
		);

		expect(saved.status).toBe(1);
		expect(parseResult(saved.stdout)).toMatchObject({
			command: "save",
			error: { code: "capture_rejected", details: { message } },
			ok: false,
		});
		expect(readFileSync(fixture.place)).toStrictEqual(original);
	});

	it("reports the snapshot's occupied capture port", async ({ expect }) => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync(
			{ studio: { saveMethod: "capture" } },
			{ studio: true },
		);
		const opened = await runBinAsync(
			["open", "--desktop", "hidden", "--json"],
			fixture.project,
			fixture.environment(),
		);
		assert(opened.status === 0, opened.stdout);
		const { place } = parseOpened(parseResult(opened.stdout).data);
		await waitForFileAsync(`${place}.lock`);
		const { port } = type({ port: "number" }).assert(
			JSON.parse(readFileSync(`${place}.capture.json`, "utf8")),
		);
		await holdPortAsync(port);

		const saved = await runBinAsync(
			["save", "--place", place, "--json"],
			fixture.project,
			fixture.environment(),
		);

		expect(saved.status).toBe(1);
		expect(parseResult(saved.stdout)).toMatchObject({
			error: { code: "capture_port_in_use" },
			ok: false,
		});
	});

	it("captures a snapshot without a session and syncs the requested input back", async ({
		expect,
	}) => {
		expect.assertions(5);

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
			FIXTURE_STUDIO_CAPTURE_SERVICES: JSON.stringify([{ name: "Workspace", roots: [0] }]),
		};
		const opened = await runBinAsync(
			["open", "--desktop", "hidden", "--json"],
			fixture.project,
			fixture.environment(variables),
		);

		expect(opened.status).toBe(0);

		const { place } = parseOpened(parseResult(opened.stdout).data);
		await waitForFileAsync(`${place}.lock`);

		const saved = await runBinAsync(
			["save", "--place", place, "--timeout", "10", "--json"],
			fixture.project,
			fixture.environment(variables),
		);

		expect(parseResult(saved.stdout), saved.stdout).toMatchObject({
			data: { place },
			ok: true,
		});

		const synced = await runBinAsync(
			["syncback", "--input", place, "--json"],
			fixture.project,
			fixture.environment(variables),
		);

		expect(parseResult(synced.stdout)).toMatchObject({ command: "syncback", ok: true });
		expect(
			readFileSync(path.join(fixture.project, "src/Edited/ChangedScript.luau"), "utf8"),
		).toBe("return 'captured edit'");
		expect(readdirSync(path.join(fixture.project, "src/Edited"))).toContain("NewPart.rbxm");
	});

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
