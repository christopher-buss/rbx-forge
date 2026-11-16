// cspell:words wslpath
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { assert, describe, it } from "vitest";
import type { TestContext } from "vitest";

import { nodeNetwork } from "../../src/seams/network.ts";
import { parseStatus } from "../../src/session/status.ts";
import { studioPlaceContent } from "../fixtures/bin/studio-stand-in.ts";
import { makeFixtureProject } from "../helpers/fixture-project.ts";
import { parseResult } from "../helpers/output.ts";
import { NATIVE_DIRECTORY, waitForFileAsync } from "../helpers/real-native.ts";

const HELPER = path.resolve(import.meta.dirname, "../fixtures/bin/fake-windows-helper.ts");

async function fixtureAsync(onTestFinished: TestContext["onTestFinished"]) {
	const project = makeFixtureProject({
		config: {
			open: { buildFirst: true },
			projectType: "luau",
			rojoPort: await nodeNetwork.freePortAsync(),
			studio: { desktop: "user" },
		},
	});
	const converter = path.join(project.project, "fixture-bin/wslpath");
	writeFileSync(converter, `#!/bin/sh\nexec "${process.execPath}" "${HELPER}" path "$@"\n`);
	chmodSync(converter, 0o755);
	const executable = path.join(project.project, "RobloxStudioBeta.exe");
	copyFileSync(process.execPath, executable);
	const environment = {
		FIXTURE_HELPER_EXECUTABLE: executable,
		FIXTURE_HELPER_STATE: path.join(project.project, "helper.json"),
		FIXTURE_ROJO_VERSION: "7.7.1",
		FIXTURE_WSL_PLUGIN: "1",
		RBX_FORGE_NATIVE_DIR: NATIVE_DIRECTORY,
		RBX_FORGE_STUDIO_PATH: process.execPath,
		RBX_FORGE_TEST_WINDOWS_HELPER: HELPER,
		WSL_DISTRO_NAME: "forge-test",
	};
	const place = path.join(project.project, "game.rbxl");
	writeFileSync(place, studioPlaceContent());
	const studio = spawn(process.execPath, [HELPER, "studio", place], {
		stdio: "ignore",
		windowsHide: true,
	});
	onTestFinished(() => {
		studio.kill();
	});
	assert(studio.pid !== undefined);
	const pid = studio.pid + 1_000_000;
	const startTime = String((BigInt(Date.now()) + 11_644_473_600_000n) * 10_000n);
	writeFileSync(
		environment.FIXTURE_HELPER_STATE,
		JSON.stringify({ actualPid: studio.pid, pid, place, startTime }),
	);
	await waitForFileAsync(`${place}.lock`);
	return {
		forge: async (args: Array<string>) => project.forge([...args, "--json"], environment),
		lock: path.join(project.project, "game.rbxl.lock"),
		pid,
	};
}

describe.skipIf(process.platform !== "linux")("wsl found Studio lifecycle", () => {
	it.for([
		["stop", { error: { code: "not_running" }, ok: false }, 3],
		[
			"restart",
			{ data: { running: true, services: { studio: { origin: "forge", status: "open" } } } },
			0,
		],
	] as const)(
		"attaches and preserves Found Studio until %s --force",
		{ timeout: 180_000 },
		async ([command, expected, downExit], { expect, onTestFinished }) => {
			expect.assertions(12);

			const project = await fixtureAsync(onTestFinished);
			onTestFinished(async () => {
				await project.forge(["down", "--force"]);
			});
			const up = await project.forge(["up", "--no-compiler", "--studio"]);

			expect(up.status, up.stdout + up.stderr).toBe(0);

			const attached = parseStatus(parseResult(up.stdout).data);
			assert(attached !== undefined);

			expect(attached.services.studio).toMatchObject({
				origin: "found",
				os: "win32",
				status: "open",
			});
			expect(attached.services.studio.pid).toBeGreaterThan(1_000_000);
			expect(attached.services.studio.pid).toBe(project.pid);

			const refused = await project.forge(["stop"]);

			expect(refused.status).toBe(1);
			expect(parseResult(refused.stdout)).toMatchObject({ error: { code: "studio_found" } });

			const kept = await project.forge(["restart"]);

			expect(kept.status, kept.stdout + kept.stderr).toBe(0);

			const status = await project.forge(["status"]);

			expect(parseStatus(parseResult(status.stdout).data)!.services.studio).toMatchObject({
				origin: "found",
				pid: attached.services.studio.pid,
				startTime: attached.services.studio.startTime,
				status: "open",
			});

			const forced = await project.forge([command, "--force"]);

			expect(forced.status, forced.stdout + forced.stderr).toBe(0);

			const after = await project.forge(["status"]);

			expect(parseResult(after.stdout)).toMatchObject(expected);

			const down = await project.forge(["down", "--force"]);

			expect(down.status, down.stdout + down.stderr).toBe(downExit);
			expect(existsSync(project.lock)).toBe(false);
		},
	);
});
