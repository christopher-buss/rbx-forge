// cspell:words wslpath
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { TestContext } from "vitest";
import { assert, describe, it } from "vitest";

import { parseStatus } from "../../src/session/status.ts";
import type { FixtureProject } from "../helpers/fixture-project.ts";
import { makeFixtureProject } from "../helpers/fixture-project.ts";
import { parseResult } from "../helpers/output.ts";
import { NATIVE_DIRECTORY } from "../helpers/real-native.ts";

const HELPER = path.resolve(import.meta.dirname, "../fixtures/bin/fake-windows-helper.ts");

describe.skipIf(process.platform !== "linux")("wsl Studio tracer", () => {
	it("fails up when Windows cannot reach the WSL listener", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(2);

		const fixture = makeFixtureProject({ config: { projectType: "luau" } });
		const environment = {
			FIXTURE_HELPER_UNREACHABLE: "1",
			RBX_FORGE_TEST_WINDOWS_HELPER: HELPER,
			WSL_DISTRO_NAME: "forge-test",
		};
		registerStop(fixture, environment, onTestFinished);
		const up = await fixture.forge(["up", "--no-compiler", "--studio", "--json"], environment);

		expect(up.status).toBe(1);
		expect(parseResult(up.stdout)).toMatchObject({
			error: { code: "wsl_network_unreachable" },
		});
	});

	it.for(["0", "1"])(
		"saves Windows Studio and closes it with dialog=%s",
		async (dialog, { expect, onTestFinished }) => {
			expect.assertions(16);

			const fixture = makeFixtureProject({
				config: {
					open: { buildFirst: true },
					projectType: "luau",
					studio: { desktop: "user", saveMethod: "menu" },
				},
			});
			const converter = path.join(fixture.project, "fixture-bin/wslpath");
			writeFileSync(
				converter,
				`#!/bin/sh\nexec "${process.execPath}" "${HELPER}" path "$@"\n`,
			);
			chmodSync(converter, 0o755);
			const executable = path.join(fixture.project, "RobloxStudioBeta.exe");
			copyFileSync(process.execPath, executable);
			const environment = {
				FIXTURE_HELPER_DIALOG: dialog,
				FIXTURE_HELPER_EXECUTABLE: executable,
				FIXTURE_HELPER_STATE: path.join(fixture.project, "helper.json"),
				FIXTURE_ROJO_VERSION: "7.7.1",
				FIXTURE_WSL_PLUGIN: "1",
				RBX_FORGE_NATIVE_DIR: NATIVE_DIRECTORY,
				RBX_FORGE_STUDIO_PATH: process.execPath,
				RBX_FORGE_TEST_WINDOWS_HELPER: HELPER,
				WSL_DISTRO_NAME: "forge-test",
			};
			const markStopped = registerStop(fixture, environment, onTestFinished);
			const up = await fixture.forge(
				["up", "--no-compiler", "--studio", "--json"],
				environment,
			);

			expect(up.status, up.stdout + up.stderr).toBe(0);

			expect(
				readFileSync(path.join(fixture.project, "windows-plugins/ForgePlugin.rbxm")),
			).toEqual(readFileSync(path.resolve("dist/forge-plugin/ForgePlugin.rbxm")));
			expect(
				existsSync(path.join(fixture.project, "windows-plugins/RojoManagedPlugin.rbxm")),
			).toBe(true);

			const build = await fixture.forge(
				["build", "--plugin", "Tool.rbxm", "--json"],
				environment,
			);

			expect(
				build.status === 0 &&
					existsSync(path.join(fixture.project, "windows-plugins/Tool.rbxm")),
				build.stdout + build.stderr,
			).toBe(true);

			const status = await fixture.forge(["status", "--json"], environment);
			const state = parseStatus(parseResult(status.stdout).data);
			assert(state !== undefined);

			expect(state.services.studio.status).toBe("open");
			expect(state.services.studio.os).toBe("win32");
			expect(state.services.studio.pid).toBeGreaterThan(1_000_000);

		const hide = await fixture.forge(["hide", "--json"], environment);

		expect(hide.status, hide.stdout + hide.stderr).toBe(0);

		function watcherPid() {
			const value: unknown = JSON.parse(
				readFileSync(environment.FIXTURE_HELPER_STATE, "utf8"),
			);
			assert(
				typeof value === "object" &&
					value !== null &&
					"watcherPid" in value &&
					typeof value.watcherPid === "number",
			);
			return value.watcherPid;
		}

		await expect.poll(() => watcherPid()).not.toBe(state.pid);

		const watcher = watcherPid();

		expect(() => process.kill(watcher, 0)).not.toThrow();

		const show = await fixture.forge(["show", "--json"], environment);

		expect(show.status, show.stdout + show.stderr).toBe(0);
		await expect
			.poll(() => {
				try {
					process.kill(watcher, 0);
					return true;
				} catch {
					return false;
				}
			})
			.toBeFalse();

			const save = await fixture.forge(["save", "--json"], environment);

			expect(save.status, save.stdout + save.stderr).toBe(0);
			expect(readFileSync(path.join(fixture.project, "game.rbxl"), "utf8")).toBe(
				"saved by Windows Studio",
			);

			const down = await fixture.forge(["down", "--json"], environment);

			expect(down.status, down.stdout + down.stderr).toBe(0);

			markStopped();

			expect(existsSync(path.join(fixture.project, "game.rbxl.lock"))).toBe(false);
		},
	);
});

function registerStop(
	fixture: FixtureProject,
	environment: Record<string, string>,
	onTestFinished: TestContext["onTestFinished"],
): () => void {
	let didStop = false;
	onTestFinished(async () => {
		if (!didStop) {
			await fixture.forge(["down", "--force", "--json"], environment);
		}
	});
	return () => {
		didStop = true;
	};
}
