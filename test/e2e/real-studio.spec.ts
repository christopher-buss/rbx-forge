/**
 * Opt-in, local only: `up`, `down`, and `stop` against the real Roblox Studio
 * of this computer. It runs only with `RBX_FORGE_TEST_REAL_STUDIO=1` on
 * Windows with Studio installed and logged in; CI never runs it. It opens
 * Studio windows on the desktop.
 *
 * Each test notes the Studio PIDs that run before it, and at its end kills
 * only Studios that were not there: a Studio the user has open is never
 * touched. It changes no Studio setting and installs nothing.
 *
 * Places (`test/fixtures/studio/`):
 *
 * - `saved.rbxl`: Studio saved it, so it has no unsaved changes and closes
 *   without a dialog. Made by opening the `rojo build` of
 *   `unsaved.project.json` in Studio and saving it.
 * - `unsaved.rbxl`: `rojo build unsaved.project.json`. Studio always takes a
 *   place fresh from Rojo as changed, so it asks to save on close.
 *   `Lighting.Technology` is set, so no Lighting migration dialog shows.
 *
 * Timings go to `RBX_FORGE_TEST_REAL_STUDIO_LOG` (NDJSON), when set.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";

import { pinNow, waitForDeathAsync } from "../helpers/worker-log.ts";
import type { Fixture } from "./session-fixture.ts";
import { makeFixtureAsync } from "./session-fixture.ts";
import type { UpRun } from "./up-fixture.ts";
import { runForgeAsync } from "./up-fixture.ts";

const { env } = process;
const IS_ENABLED = env["RBX_FORGE_TEST_REAL_STUDIO"] === "1" && process.platform === "win32";
const PLACES = path.join(import.meta.dirname, "..", "fixtures", "studio");
/** A name no place of the user has: its auto-recovery files are forge's. */
const PLACE = "forge-real-studio.rbxl";
const UP = ["up", "--no-compiler", "--json"];
/** How long Studio may take to open a place. */
const OPEN_MS = 90_000;
/** How long Studio stays free of dialogs before a test counts it loaded. */
const QUIET_MS = 3000;
/** How a Studio that closes on the request goes. */
const CLOSED_END: unknown = expect.toBeOneOf(["exited", "lock_released"]);

/**
 * The PIDs of the Studios that run now.
 *
 * @returns Their PIDs.
 */
function studioPids(): Array<number> {
	const { stdout } = spawnSync(
		"tasklist",
		// cspell:disable-next-line -- a tasklist filter
		["/FI", "IMAGENAME eq RobloxStudioBeta.exe", "/FO", "CSV", "/NH"],
		{ encoding: "utf8", windowsHide: true },
	);
	return Array.from(stdout.matchAll(/^"RobloxStudioBeta\.exe","(\d+)"/gm), ([, pid]) => {
		return Number(pid);
	});
}

/**
 * Kill, when the test ends, every Studio that did not run before it.
 */
function killNewStudiosAtEnd(): void {
	const before = new Set(studioPids());
	onTestFinished(async () => {
		const added = studioPids().filter((pid) => !before.has(pid));
		for (const pid of added) {
			pinNow(pid)?.kill();
		}

		await waitForDeathAsync(added, 10_000);
	});
}

/**
 * Note one timing.
 *
 * @param entry - What was timed, and how long it took.
 */
function note(entry: Record<string, unknown>): void {
	const log = env["RBX_FORGE_TEST_REAL_STUDIO_LOG"];
	if (log !== undefined) {
		appendFileSync(log, `${JSON.stringify(entry)}\n`);
	}
}

/**
 * The real environment for forge and Studio: the installed Studio, the
 * user's own folders (the e2e setup replaces them), and the whole `PATH`
 * after the fixture binaries.
 *
 * @param fixture - The project, for its fixture binaries.
 * @returns The variables for forge's run.
 */
function realVariables(fixture: Fixture): Record<string, string> {
	return {
		HOME: env["RBX_FORGE_TEST_REAL_HOME"] ?? "",
		LOCALAPPDATA: env["RBX_FORGE_TEST_REAL_LOCALAPPDATA"] ?? "",
		PATH: `${fixture.environment()["PATH"] ?? ""}${path.delimiter}${env["PATH"] ?? ""}`,
		RBX_FORGE_STUDIO_PATH: "",
		USERPROFILE: env["RBX_FORGE_TEST_REAL_USERPROFILE"] ?? "",
	};
}

/**
 * A project whose place is a copy of a fixture place.
 *
 * @param fixturePlace - `saved.rbxl` or `unsaved.rbxl`.
 * @returns The project, with the copy as its place.
 */
async function makeRealProjectAsync(fixturePlace: string): Promise<Fixture> {
	const fixture = await makeFixtureAsync({
		buildOutputPath: PLACE,
		open: { buildFirst: false },
	});
	copyFileSync(path.join(PLACES, fixturePlace), path.join(fixture.project, PLACE));
	return { ...fixture, place: path.join(fixture.project, PLACE) };
}

/**
 * Wait until Studio has the place open (the session says so), and is free
 * of dialogs (such as "Opening place") for a while.
 *
 * @param fixture - The project.
 * @param up - The `up` run.
 * @returns The PID the session recorded, and the PID the lock file names.
 * @rejects When Studio does not open the place in time.
 */
async function waitForLoadedAsync(fixture: Fixture, up: UpRun): Promise<[unknown, number]> {
	const state = path.join(
		fixture.project,
		".forge",
		"sessions",
		String(up.result.data!["sessionId"]),
		"state.json",
	);
	const deadline = Date.now() + OPEN_MS;
	while (!existsSync(state) || !readFileSync(state, "utf8").includes('"status":"open"')) {
		if (Date.now() > deadline) {
			throw new Error(`Studio did not open ${fixture.place} in time`);
		}

		await sleep(100);
	}

	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the session's state contract
	const status = JSON.parse(readFileSync(state, "utf8")) as {
		services: { studio: { pid?: number } };
	};
	const lockPid = Number(readFileSync(`${fixture.place}.lock`, "utf8").split(/\r?\n/, 1)[0]);
	const pinned = pinNow(lockPid);
	let quietSince = Date.now();
	while (Date.now() - quietSince < QUIET_MS) {
		if (Date.now() > deadline) {
			throw new Error(`Studio did not open ${fixture.place} in time`);
		}

		if (pinned?.isBlocked() === true) {
			quietSince = Date.now();
		}

		await sleep(100);
	}

	return [status.services.studio.pid, lockPid];
}

describe.skipIf(!IS_ENABLED)("real Roblox Studio", () => {
	it(
		"should open Studio directly with up, and close it with down",
		{ timeout: 240_000 },
		async () => {
			expect.assertions(4);

			killNewStudiosAtEnd();
			const fixture = await makeRealProjectAsync("saved.rbxl");
			const started = Date.now();
			const up = await runForgeAsync(fixture, UP, realVariables(fixture));
			const [recorded, lockPid] = await waitForLoadedAsync(fixture, up);
			const opened = Date.now();
			const down = await runForgeAsync(fixture, ["down", "--json"], realVariables(fixture));
			note({ closeMs: Date.now() - opened, openMs: opened - started, test: "down" });

			expect(recorded).toBe(lockPid);
			expect(down.result.data).toMatchObject({
				studio: { end: CLOSED_END, forced: false, pid: lockPid, status: "closed" },
			});
			await expect(waitForDeathAsync([lockPid], 10_000)).resolves.toStrictEqual([]);
			expect(existsSync(`${fixture.place}.lock`)).toBeFalse();
		},
	);

	it("should close the session's Studio with stop", { timeout: 240_000 }, async () => {
		expect.assertions(2);

		killNewStudiosAtEnd();
		const fixture = await makeRealProjectAsync("saved.rbxl");
		const up = await runForgeAsync(fixture, UP, realVariables(fixture));
		const [, lockPid] = await waitForLoadedAsync(fixture, up);
		const loaded = Date.now();
		const stop = await runForgeAsync(fixture, ["stop", "--json"], realVariables(fixture));
		note({ closeMs: Date.now() - loaded, test: "stop" });

		expect(stop.result.data).toMatchObject({
			end: CLOSED_END,
			forced: false,
			pid: lockPid,
			stopped: true,
		});
		await expect(waitForDeathAsync([lockPid], 10_000)).resolves.toStrictEqual([]);
	});

	it(
		"should end a Studio that asks to save at once, and remove its lock file",
		{ timeout: 240_000 },
		async () => {
			expect.assertions(3);

			killNewStudiosAtEnd();
			const fixture = await makeRealProjectAsync("unsaved.rbxl");
			const up = await runForgeAsync(fixture, UP, realVariables(fixture));
			const [, lockPid] = await waitForLoadedAsync(fixture, up);
			const loaded = Date.now();
			const down = await runForgeAsync(fixture, ["down", "--json"], realVariables(fixture));
			note({ closeMs: Date.now() - loaded, test: "dialog" });

			expect(down.result.data).toMatchObject({
				studio: {
					end: "dialog",
					forced: true,
					pid: lockPid,
					recovery: { mode: "move", warnings: [] },
					status: "closed",
				},
			});
			await expect(waitForDeathAsync([lockPid], 10_000)).resolves.toStrictEqual([]);
			expect(existsSync(`${fixture.place}.lock`)).toBeFalse();
		},
	);
});
