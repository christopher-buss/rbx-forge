// cspell:words wslpath
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { assert, describe, it } from "vitest";

import { makeFixtureProject } from "../helpers/fixture-project.ts";
import { parseLines, parseResult } from "../helpers/output.ts";
import { NATIVE_DIRECTORY, waitForFileAsync } from "../helpers/real-native.ts";

const HELPER = path.resolve(import.meta.dirname, "../fixtures/bin/fake-windows-helper.ts");

describe.skipIf(process.platform !== "linux")("wsl snapshots", () => {
	it("opens on the hidden desktop, watches Lighting independently, saves and prunes", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(13);

		const fixture = makeFixtureProject({
			config: { projectType: "luau", studio: { desktop: "hidden", saveMethod: "menu" } },
		});
		const converter = path.join(fixture.project, "fixture-bin/wslpath");
		writeFileSync(
			converter,
			`#!/bin/sh
exec "${process.execPath}" "${HELPER}" path "$@"
`,
		);
		chmodSync(converter, 0o755);
		const executable = path.join(fixture.project, "RobloxStudioBeta.exe");
		copyFileSync(process.execPath, executable);
		const environment = {
			FIXTURE_HELPER_EXECUTABLE: executable,
			FIXTURE_HELPER_LIGHTING: "1",
			FIXTURE_HELPER_STATE: path.join(fixture.project, "helper.json"),
			RBX_FORGE_NATIVE_DIR: NATIVE_DIRECTORY,
			RBX_FORGE_STUDIO_PATH: process.execPath,
			RBX_FORGE_TEST_WINDOWS_HELPER: HELPER,
			WSL_DISTRO_NAME: "forge-test",
		};
		onTestFinished(async () => {
			await fixture.forge(["stop", "--json"], environment);
		});
		const snapshots = path.join(fixture.project, ".forge/snapshots");
		mkdirSync(snapshots, { recursive: true });
		const old = path.join(snapshots, "2000-01-01_game.rbxl");
		writeFileSync(old, "old");
		writeFileSync(`${old}.capture.json`, "{}");
		for (const year of [2001, 2002, 2003, 2004]) {
			writeFileSync(path.join(snapshots, `${year}-01-01_game.rbxl`), "kept");
		}

		const opened = await fixture.forge(["open", "--json"], environment);

		expect(opened.status, opened.stdout + opened.stderr).toBe(0);

		const { data } = parseResult(opened.stdout);
		assert(data !== undefined && "place" in data && typeof data["place"] === "string");
		const { place } = data;

		expect(data).toMatchObject({
			desktop: "hidden",
			pruned: [old],
			studio: { desktop: "hidden", os: "win32" },
		});
		expect(existsSync(old)).toBeFalse();
		expect(existsSync(`${old}.capture.json`)).toBeFalse();

		await waitForFileAsync(`${environment.FIXTURE_HELPER_STATE}.lighting`);
		const lighting: unknown = JSON.parse(
			readFileSync(`${environment.FIXTURE_HELPER_STATE}.lighting`, "utf8"),
		);

		assert(
			typeof lighting === "object" &&
				lighting !== null &&
				"helperPid" in lighting &&
				"watcherPid" in lighting,
		);

		expect(typeof lighting.helperPid).toBe("number");
		expect(typeof lighting.watcherPid).toBe("number");
		expect(lighting.helperPid).not.toBe(lighting.watcherPid);

		const saved = await fixture.forge(["save", "--place", place, "--json"], {
			...environment,
			FIXTURE_HELPER_DROP: "requestSave",
		});

		expect(saved.status, saved.stdout + saved.stderr).toBe(0);
		expect(parseLines(saved.stdout)).toContainEqual({
			message: "Windows Studio control was lost; recovering.",
			type: "warning",
		});
		expect(parseLines(saved.stdout)).toContainEqual({
			message: "Windows Studio control recovered.",
			type: "info",
		});
		expect(parseResult(saved.stdout)).toMatchObject({ data: { desktop: "hidden", place } });
		expect(readFileSync(place, "utf8")).toBe("saved by Windows Studio");

		const stopped = await fixture.forge(["stop", "--place", place, "--json"], environment);

		expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
	});
});
