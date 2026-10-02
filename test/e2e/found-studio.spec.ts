/**
 * A found Studio, one that already had the place open when the session
 * attached it, as real processes: `down` and `restart` leave it open, and
 * only `--force` closes it (#84).
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { EXIT_FAILURE } from "../../src/exit-codes.ts";
import { openStudioStandInAsync, pidOf, waitForFileAsync } from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";
import { isProcessAlive, readWorkerLog, waitForDeathAsync } from "../helpers/worker-log.ts";
import type { Fixture } from "./session-fixture.ts";
import { IS_MACOS, IS_WINDOWS, makeFixtureAsync } from "./session-fixture.ts";
import type { UpRun } from "./up-fixture.ts";
import { runForgeAsync, WATCH_COMMAND } from "./up-fixture.ts";

/** A Luau project whose compiler runs in watch mode. */
const PROJECT = { ...WATCH_COMMAND, open: { buildFirst: true } };
const UP_STUDIO = ["up", "--studio", "--json"];
/** How long a dead process may stay a zombie before its parent reaps it. */
const REAP_MS = 2000;

/** A session that attached the Studio stand-in that had its place open. */
interface FoundSession {
	fixture: Fixture;
	studio: number;
	up: UpRun;
}

/**
 * Open the place in the Studio stand-in, then attach it with `up --studio`.
 *
 * @param variables - Fixture variables for Studio and the session.
 * @returns The fixture, the Studio's PID, and the `up` run.
 */
async function upFoundAsync(variables: Record<string, string> = {}): Promise<FoundSession> {
	const fixture = await makeFixtureAsync(PROJECT, { studio: true });
	const studio = pidOf(await openStudioStandInAsync(fixture.place, variables));
	const up = await runForgeAsync(fixture, UP_STUDIO, variables);
	return { fixture, studio, up };
}

/**
 * The PIDs of the fixture processes with this role, builds left out.
 *
 * @param fixture - The project.
 * @param role - Such as `rojo`.
 * @returns Their PIDs, in start order.
 */
function pidsOf(fixture: Fixture, role: string): Array<number> {
	return readWorkerLog(fixture.log)
		.filter((record) => record.role === role && record.args[0] !== "build")
		.map(({ pid }) => pid);
}

/**
 * The AutoSaves folder the stand-in writes to, under a scratch home.
 *
 * @param home - `LOCALAPPDATA` (Windows) or `HOME` (macOS).
 * @returns The folder.
 */
function autoSavesUnder(home: string): string {
	const root = IS_WINDOWS ? home : path.join(home, "Library", "Application Support");
	return path.join(root, "Roblox", "RobloxStudio", "AutoSaves");
}

describe("a found Studio", () => {
	it("should report its origin, and stay open on down while Rojo stops", async () => {
		expect.assertions(4);

		const { fixture, studio, up } = await upFoundAsync();
		const rojo = pidsOf(fixture, "rojo");
		const down = await runForgeAsync(fixture, ["down", "--json"]);

		expect(up.result.data).toMatchObject({
			services: { studio: { origin: "found", owner: null, pid: studio, status: "open" } },
		});
		expect(down.result.data).toMatchObject({
			parts: { kept: [{ owner: null, part: "studio" }], stopped: ["rojo", "compiler"] },
			status: "stopped",
			studio: { status: "kept" },
		});
		expect(isProcessAlive(studio)).toBeTrue();
		await expect(waitForDeathAsync(rojo, REAP_MS)).resolves.toStrictEqual([]);
	});

	it("should keep it on restart, and restart the compiler and Rojo on its port", async () => {
		expect.assertions(3);

		const { fixture, studio } = await upFoundAsync();
		const restart = await runForgeAsync(fixture, ["restart", "--json"]);

		expect(restart.result.data).toMatchObject({
			added: ["compiler", "rojo"],
			kept: [{ owner: null, part: "studio" }],
			services: {
				rojo: { port: fixture.port, status: "ready" },
				studio: { origin: "found", pid: studio, status: "open" },
			},
			stopped: ["rojo", "compiler"],
			studio: { status: "kept" },
		});
		expect(isProcessAlive(studio)).toBeTrue();
		expect(pidsOf(fixture, "studio")).toStrictEqual([]);
	});

	it("should fail stop with studio_found, and close it on stop --force", async () => {
		expect.assertions(3);

		const { fixture, studio } = await upFoundAsync();
		const stop = await runForgeAsync(fixture, ["stop", "--json"]);
		const wasAlive = isProcessAlive(studio);
		const forced = await runForgeAsync(fixture, ["stop", "--force", "--json"]);

		expect([stop.status, stop.result.error]).toMatchObject([
			EXIT_FAILURE,
			{ code: "studio_found" },
		]);
		expect(wasAlive).toBeTrue();
		expect(forced.result).toMatchObject({
			data: { pid: studio, place: fixture.place, stopped: true },
			ok: true,
		});
	});

	it("should close it on restart --force, and open the place again", async () => {
		expect.assertions(2);

		const { fixture, studio } = await upFoundAsync();
		const restart = await runForgeAsync(fixture, ["restart", "--force", "--json"]);

		expect(restart.result.data).toMatchObject({
			added: ["compiler", "studio", "rojo"],
			services: { studio: { origin: "forge", status: "open" } },
			stopped: ["studio", "rojo", "compiler"],
			studio: { pid: studio, status: "closed" },
		});
		await expect(waitForDeathAsync([studio], REAP_MS)).resolves.toStrictEqual([]);
	});

	it.skipIf(!IS_WINDOWS && !IS_MACOS)(
		"should leave its auto-recovery files on down",
		async () => {
			expect.assertions(1);

			const home = makeTemporaryDirectory();
			const variables = { FIXTURE_STUDIO_AUTOSAVE: "1", HOME: home, LOCALAPPDATA: home };
			const { fixture } = await upFoundAsync(variables);
			const saves = autoSavesUnder(home);
			await waitForFileAsync(path.join(saves, "game_AutoRecovery_0.rbxl"));
			await runForgeAsync(fixture, ["down", "--json"], variables);

			expect(readdirSync(saves)).toStrictEqual(["game_AutoRecovery_0.rbxl"]);
		},
	);
});
