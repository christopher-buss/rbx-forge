import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

import { captureRojo, makeCaptureModel } from "../helpers/capture-fixture.ts";
import { parseResult } from "../helpers/output.ts";
import { runBinAsync } from "./run-bin.ts";
import { makeFixtureAsync, START_STUDIO, startReadyAsync } from "./session-fixture.ts";

async function captureSessionAsync() {
	const fixture = await makeFixtureAsync({ studio: { saveMethod: "capture" } }, { studio: true });
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
		FIXTURE_STUDIO_CAPTURE_DELAY_MS: "150",
		FIXTURE_STUDIO_CAPTURE_MODEL: makeCaptureModel(fixture.project, rojo),
		FIXTURE_STUDIO_CAPTURE_ROJO_PORT: String(fixture.port),
		FIXTURE_STUDIO_CAPTURE_SERVICES: JSON.stringify([{ name: "Workspace", roots: [0] }]),
	};
	await startReadyAsync(fixture, START_STUDIO, variables);
	return { fixture, variables };
}

async function failingCaptureSessionAsync(
	mode: "assembly" | "busy" | "disconnected" | "play_mode" | "timeout",
) {
	const fixture = await makeFixtureAsync({ studio: { saveMethod: "capture" } }, { studio: true });
	const malformed = path.join(fixture.project, "malformed.rbxm");
	writeFileSync(malformed, "invalid captured model");
	const failures = {
		assembly: { FIXTURE_STUDIO_CAPTURE_MODEL: malformed },
		busy: { FIXTURE_STUDIO_CAPTURE_ERROR: "busy" },
		disconnected: { FIXTURE_STUDIO_CAPTURE: "disconnect" },
		play_mode: { FIXTURE_STUDIO_CAPTURE_ERROR: "play_mode" },
		timeout: { FIXTURE_STUDIO_CAPTURE: "timeout" },
	};
	const variables = {
		FIXTURE_STUDIO_CAPTURE_ROJO_PORT: String(fixture.port),
		...failures[mode],
	};
	await startReadyAsync(fixture, START_STUDIO, variables);
	return { fixture, variables };
}

describe("forge sync through the capture plugin", () => {
	it.for([
		{ error: { code: "capture_not_connected" }, mode: "disconnected" },
		{
			error: { code: "capture_rejected", details: { reason: "play_mode" } },
			mode: "play_mode",
		},
		{ error: { code: "capture_rejected", details: { reason: "busy" } }, mode: "busy" },
		{ error: { code: "capture_timeout" }, mode: "timeout" },
		{ error: { code: "capture_assembly_failed" }, mode: "assembly" },
	] as const)("reports $mode without changing the place", async ({ error, mode }, { expect }) => {
		expect.assertions(3);

		const { fixture, variables } = await failingCaptureSessionAsync(mode);
		const before = readFileSync(fixture.place);
		const saved = await runBinAsync(
			["save", "--timeout", "2", "--json"],
			fixture.project,
			fixture.environment(variables),
		);

		expect(saved.status).toBe(1);
		expect(parseResult(saved.stdout)).toMatchObject({ command: "save", error, ok: false });
		expect(readFileSync(fixture.place)).toStrictEqual(before);
	});

	it("captures before syncback and serializes a simultaneous save through the same session", async ({
		expect,
	}) => {
		expect.assertions(4);

		const { fixture, variables } = await captureSessionAsync();
		const [synced, saved] = await Promise.all([
			runBinAsync(["sync", "--json"], fixture.project, fixture.environment(variables)),
			runBinAsync(
				["save", "--timeout", "5", "--json"],
				fixture.project,
				fixture.environment(variables),
			),
		]);

		expect(parseResult(synced.stdout)).toMatchObject({
			command: "sync",
			data: { capture: { method: "capture", place: fixture.place } },
			ok: true,
		});
		expect(parseResult(saved.stdout)).toMatchObject({
			command: "save",
			data: { method: "capture" },
			ok: true,
		});
		expect(
			readFileSync(path.join(fixture.project, "src/Edited/ChangedScript.luau"), "utf8"),
		).toBe("return 'captured edit'");
		expect(readdirSync(path.join(fixture.project, "src/Edited"))).toStrictEqual([
			"ChangedScript.luau",
			"NewPart.rbxm",
		]);
	});
});
