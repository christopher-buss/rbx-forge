/**
 * Opt-in, local only: `up`, `down`, and `stop` against the real Roblox Studio
 * of this computer. It runs only with `RBX_FORGE_TEST_REAL_STUDIO=1` on
 * Windows with Studio installed and logged in, and genuine Rojo 7.7.1 (see
 * `genuineRojo`); CI never runs it. It opens Studio windows on the desktop.
 *
 * Each test cleans up only the Studio returned by its launcher or recorded
 * in its session, through a PID and start-time pin. The managed Rojo plugin
 * must already have the current patch; these tests never install or patch it.
 * Every direct launch installs the inert forge plugin in the user's Plugins
 * folder, as forge does for users; a current copy is left unwritten.
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
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import type { PinnedProcess } from "../../src/native/addon.ts";
import { readVariable } from "../../src/process/environment.ts";
import { parseStatus } from "../../src/session/status.ts";
import { SCRIPTS, VERSION } from "../../src/studio/rojo-plugin.ts";
import { parseOpened } from "../helpers/output.ts";
import { loadRealNative } from "../helpers/real-native.ts";
import { studioCleanup } from "../helpers/real-studio-cleanup.ts";
import { genuineRojo } from "../helpers/real-studio-sync-fixture.ts";
import { pinNow } from "../helpers/worker-log.ts";
import type { Fixture } from "./session-fixture.ts";
import { makeFixtureAsync } from "./session-fixture.ts";
import type { UpRun } from "./up-fixture.ts";
import { runForgeAsync } from "./up-fixture.ts";

const { env } = process;
const IS_ENABLED = env["RBX_FORGE_TEST_REAL_STUDIO"] === "1" && process.platform === "win32";
const PLACES = path.join(import.meta.dirname, "..", "fixtures", "studio");
/** A name no place of the user has: its auto-recovery files are forge's. */
const PLACE = "forge-real-studio.rbxl";
/** How long Studio may take to open a place. */
const OPEN_MS = 90_000;
/** How long Studio stays free of dialogs before a test counts it loaded. */
const QUIET_MS = 3000;
/** How a Studio that closes on the request goes. */
const CLOSED_END: unknown = expect.toBeOneOf(["exited", "lock_released"]);

/**
 * Fail before production `up` could install or patch the shared managed model.
 */
function requireCurrentManagedPlugin(): void {
	const home = readVariable(env, "RBX_FORGE_TEST_REAL_USERPROFILE", process.platform);
	assert(home !== undefined);
	const managed = path.join(home, "AppData/Local/Roblox/Plugins/RojoManagedPlugin.rbxm");
	assert(
		existsSync(managed),
		"Install the current managed Rojo plugin before real Studio e2e tests",
	);
	const original = readFileSync(managed);
	const modified = statSync(managed).mtimeMs;
	const native = loadRealNative();
	const sources = native.readModelScriptSources(
		managed,
		SCRIPTS.map(({ name }) => ["Rojo", "Plugin", name]),
	);
	assert.deepEqual(
		sources,
		SCRIPTS.map(({ hash, source }) => `-- rbx-forge patch ${VERSION} stock ${hash}\n${source}`),
		"Update the managed Rojo plugin before real Studio e2e tests",
	);
	onTestFinished(() => {
		assert.deepEqual(readFileSync(managed), original);
		assert.equal(statSync(managed).mtimeMs, modified);
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
 * user's own folders (the e2e setup replaces them), and the user's `PATH`
 * with genuine Rojo first. No fixture binary: the managed plugin acknowledges
 * readiness only after a real initial sync, and a Rojo shim (rokit) runs the
 * next `rojo` on `PATH`.
 *
 * @returns The variables for forge's run.
 */
function realVariables(): Record<string, string> {
	return {
		HOME: env["RBX_FORGE_TEST_REAL_HOME"] ?? "",
		LOCALAPPDATA: env["RBX_FORGE_TEST_REAL_LOCALAPPDATA"] ?? "",
		PATH: [path.dirname(genuineRojo()), env["PATH"] ?? ""].join(path.delimiter),
		RBX_FORGE_STUDIO_PATH: "",
		RBX_FORGE_TEST_NO_INSTALLED_STUDIO: "",
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

async function compatibilitySnapshotAsync(fixturePlace = "compatibility.rbxl"): Promise<Fixture> {
	const fixture = await makeFixtureAsync({ projectType: "luau" });
	const directory = path.join(fixture.project, "node_modules", "snapshot-rojo");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		path.join(fixture.project, "package.json"),
		JSON.stringify({ devDependencies: { "snapshot-rojo": "1.0.0" } }),
	);
	writeFileSync(
		path.join(directory, "package.json"),
		JSON.stringify({ name: "snapshot-rojo", bin: { rojo: "cli.mjs" } }),
	);
	writeFileSync(
		path.join(directory, "cli.mjs"),
		`import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const output = process.argv[process.argv.indexOf('--output') + 1];
mkdirSync(path.dirname(output), { recursive: true });
copyFileSync(${JSON.stringify(path.join(PLACES, fixturePlace))}, output);`,
	);
	return fixture;
}

/**
 * Start a session with `up --studio`, which opens the place in the
 * installed Studio.
 *
 * @param fixture - The project.
 * @param desktop - Where Studio opens.
 * @returns The session's id.
 */
async function upStudioAsync(
	fixture: Fixture,
	desktop: "hidden" | "user" = "user",
): Promise<string> {
	requireCurrentManagedPlugin();
	const own = studioCleanup(fixture.project);
	const up = await runForgeAsync(
		fixture,
		["up", "--studio", "--desktop", desktop, "--json"],
		realVariables(),
	);
	const sessionId = String(up.result.data!["sessionId"]);
	const state = parseStatus(
		JSON.parse(
			readFileSync(
				path.join(fixture.project, ".forge/sessions", sessionId, "state.json"),
				"utf8",
			),
		),
	);
	const studio = state?.services.studio;
	assert(studio?.pid !== undefined && studio.startTime !== undefined);
	own({ pid: studio.pid, startTime: studio.startTime });
	return sessionId;
}

/**
 * Wait until Studio has the place open (the session says so), and is free
 * of dialogs (such as "Opening place") for a while.
 *
 * @param fixture - The project.
 * @param sessionId - The session that opens Studio.
 * @returns The PID the session recorded, the lock PID and its verified pin.
 * @rejects When Studio does not open the place in time.
 */
async function waitForLoadedAsync(
	fixture: Fixture,
	sessionId: string,
): Promise<[unknown, number, PinnedProcess]> {
	const state = path.join(fixture.project, ".forge", "sessions", sessionId, "state.json");
	const deadline = Date.now() + OPEN_MS;
	while (!existsSync(state) || !readFileSync(state, "utf8").includes('"status":"open"')) {
		if (Date.now() > deadline) {
			throw new Error(`Studio did not open ${fixture.place} in time`);
		}

		await sleep(100);
	}

	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the session's state contract
	const status = JSON.parse(readFileSync(state, "utf8")) as {
		services: { studio: { pid?: number; startTime?: string } };
	};
	const lockPid = Number(readFileSync(`${fixture.place}.lock`, "utf8").split(/\r?\n/, 1)[0]);
	assert(status.services.studio.pid === lockPid);
	const pinned = pinNow(lockPid);
	assert(pinned !== undefined && pinned.startTime === status.services.studio.startTime);
	let quietSince = Date.now();
	while (Date.now() - quietSince < QUIET_MS) {
		if (Date.now() > deadline) {
			throw new Error(`Studio did not open ${fixture.place} in time`);
		}

		if (pinned.isBlocked()) {
			quietSince = Date.now();
		}

		await sleep(100);
	}

	return [status.services.studio.pid, lockPid, pinned];
}

/**
 * Read focus without activating or switching any desktop.
 * @returns The PID that owns the foreground window.
 */
function foregroundOwner(): number {
	const { status, stdout } = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class ForgeForeground { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint owner); }\'; $owner = 0; [void][ForgeForeground]::GetWindowThreadProcessId([ForgeForeground]::GetForegroundWindow(), [ref]$owner); $owner',
		],
		{ encoding: "utf8", windowsHide: true },
	);
	assert(status === 0);
	return Number(stdout.trim());
}

/**
 * Studio must not take focus; the user may move it during a run.
 * @param studio - The Studio PID.
 * @returns A matcher for {@link foregroundOwner}.
 */
function notOwnedBy(studio: number): unknown {
	return expect.toSatisfy((owner: number) => owner !== studio);
}

/** The forge plugin this build ships. */
const BUNDLED_PLUGIN = path.join(import.meta.dirname, "../../dist/forge-plugin/ForgePlugin.rbxm");

/**
 * The installed forge plugin in the user's Plugins folder.
 *
 * @returns Its path.
 */
function installedPlugin(): string {
	const home = env["RBX_FORGE_TEST_REAL_USERPROFILE"] ?? "";
	return path.join(home, "AppData/Local/Roblox/Plugins/ForgePlugin.rbxm");
}

/**
 * The log of the Studio that opened `place`: Studio writes its command line,
 * with the place, at the top of its log.
 *
 * @param place - The snapshot this test opened.
 * @returns The log's lines; empty until Studio writes it.
 */
function studioLogLines(place: string): Array<string> {
	const logs = path.join(env["RBX_FORGE_TEST_REAL_LOCALAPPDATA"] ?? "", "Roblox", "logs");
	const needle = place.replaceAll("\\", "/");
	return (
		readdirSync(logs)
			.filter((file) => file.includes("_Studio_"))
			.map((name) => readFileSync(path.join(logs, name), "utf8").split(/\r?\n/u))
			.find((lines) => {
				return lines
					.slice(0, 20)
					.some((line) => line.replaceAll("\\", "/").includes(needle));
			}) ?? []
	);
}

function hasRunForgePlugin(place: string): boolean {
	return studioLogLines(place).some((line) => line.includes("loadPlugin user_ForgePlugin.rbxm"));
}

/**
 * Open a saved snapshot on the hidden desktop; the test's end stops its Studio.
 *
 * @returns The snapshot, and the installed forge plugin's modification time.
 */
async function openPluginSnapshotAsync(): Promise<{ place: string; pluginModified: number }> {
	const fixture = await compatibilitySnapshotAsync("saved.rbxl");
	const pin = studioCleanup();
	const opened = await runForgeAsync(
		fixture,
		["open", "--desktop", "hidden", "--json"],
		realVariables(),
	);
	const { place, studio } = parseOpened(opened.result.data);
	assert(opened.status === 0 && studio !== null, JSON.stringify(opened.result));
	pin(studio);
	const { mtimeMs, size } = statSync(installedPlugin());
	note({ command: "forge-plugin-open", plugin: size, result: opened.result });
	return { place, pluginModified: mtimeMs };
}

/**
 * Lines in which Studio reads and loads a user plugin, and restores its IDE
 * state.
 */
const PLUGIN_LOAD_LINE =
	/\[FLog::(?:PluginFileRead|PluginLoadingEnhanced|PluginDebugState)\] (?:Hashing Plugin '|Plugin file read '|loadPlugin |Restoring (?:IDE|debugger) state for plugin `)user_ForgePlugin\.rbxm/u;

function saveOutcome(run: UpRun): string {
	return run.status === 0 ? "saved" : JSON.stringify(run.result);
}

describe.skipIf(!IS_ENABLED)("real Roblox Studio", () => {
	it(
		"dismisses hidden snapshot Compatibility lighting after the open CLI exits",
		{ timeout: 150_000 },
		async () => {
			expect.assertions(6);

			const fixture = await compatibilitySnapshotAsync();
			const pinSnapshot = studioCleanup();
			const opened = await runForgeAsync(
				fixture,
				["open", "--desktop", "hidden", "--json"],
				realVariables(),
			);

			expect(opened.status).toBe(0);

			const { place, studio } = parseOpened(opened.result.data);
			assert(studio !== null);
			const pinned = pinSnapshot(studio);
			note({
				bytes: statSync(place).size,
				command: "snapshot-open",
				executable: pinned.executablePath(),
				result: opened.result,
			});

			await expect
				.poll(() => existsSync(`${place}.lock`), { interval: 100, timeout: OPEN_MS })
				.toBeTrue();
			expect(Number(readFileSync(`${place}.lock`, "utf8").split(/\r?\n/, 1)[0])).toBe(
				studio.pid,
			);

			await sleep(10_000);

			await expect
				.poll(() => pinned.isBlocked(), { interval: 500, timeout: 30_000 })
				.toBeFalse();
			expect(pinned.isAlive()).toBeTrue();
			expect(foregroundOwner()).toStrictEqual(notOwnedBy(studio.pid));
		},
	);

	it(
		"installs the forge plugin, which Studio loads and which stays inert",
		{ timeout: 300_000 },
		async () => {
			expect.assertions(7);

			const first = await openPluginSnapshotAsync();
			const second = await openPluginSnapshotAsync();

			expect(readFileSync(installedPlugin())).toStrictEqual(readFileSync(BUNDLED_PLUGIN));
			// The second launch found a current copy and left it unwritten.
			expect(second.pluginModified).toBe(first.pluginModified);

			await expect
				.poll(() => hasRunForgePlugin(first.place), { interval: 500, timeout: OPEN_MS })
				.toBeTrue();
			await expect
				.poll(() => existsSync(`${first.place}.lock`), { interval: 100, timeout: OPEN_MS })
				.toBeTrue();

			await sleep(QUIET_MS);
			const lines = studioLogLines(first.place);
			const mentions = lines.filter((line) => line.includes("ForgePlugin"));

			expect(mentions).not.toBeEmpty();
			expect(mentions.filter((line) => !PLUGIN_LOAD_LINE.test(line))).toStrictEqual([]);
			expect(lines.filter((line) => line.includes("ForgeCapture"))).toStrictEqual([]);
		},
	);

	it(
		"shows, hides, and saves the same session Studio while hidden",
		{ timeout: 600_000 },
		async () => {
			expect.assertions(4);

			const fixture = await makeRealProjectAsync("saved.rbxl");
			const sessionId = await upStudioAsync(fixture, "hidden");
			const [, original] = await waitForLoadedAsync(fixture, sessionId);
			const before = await runForgeAsync(fixture, ["status", "--json"], realVariables());
			assert(before.result.data !== undefined, "status returns data");
			const { services } = before.result.data;
			assert(
				typeof services === "object" && services !== null && "rojo" in services,
				"Rojo status recorded",
			);
			const shown = await runForgeAsync(fixture, ["show", "--json"], realVariables());
			const [, visible] = await waitForLoadedAsync(fixture, sessionId);

			expect(shown).toMatchObject({
				result: {
					data: {
						from: "hidden",
						pid: original,
						to: "user",
					},
				},
				status: 0,
			});

			assert(visible === original, "show retains Studio PID");

			const hidden = await runForgeAsync(fixture, ["hide", "--json"], realVariables());
			const [, replacement] = await waitForLoadedAsync(fixture, sessionId);

			expect(hidden).toMatchObject({
				result: {
					data: {
						from: "user",
						pid: original,
						to: "hidden",
					},
				},
				status: 0,
			});

			assert(replacement === original, "hide retains Studio PID");

			const saved = await runForgeAsync(fixture, ["save", "--json"], realVariables());

			expect(saved).toMatchObject({
				result: { data: { pid: original, place: fixture.place } },
				status: 0,
			});

			const after = await runForgeAsync(fixture, ["status", "--json"], realVariables());

			expect(after.result.data).toMatchObject({
				services: { rojo: services.rojo },
				sessionId,
			});
		},
	);

	it.for([
		{
			desktop: "user",
			expectedFocus: (_studio: number): unknown => expect.any(Number),
		},
		{ desktop: "hidden", expectedFocus: notOwnedBy },
	] as const)(
		"saves Studio on the $desktop desktop",
		{ timeout: 240_000 },
		async ({ desktop, expectedFocus }) => {
			expect.assertions(5);

			const fixture = await makeRealProjectAsync("unsaved.rbxl");
			const sessionId = await upStudioAsync(fixture, desktop);
			const [, lockPid] = await waitForLoadedAsync(fixture, sessionId);
			const before = statSync(fixture.place).mtimeMs;
			const save = await runForgeAsync(
				fixture,
				["save", "--timeout", "30", "--json"],
				realVariables(),
			);
			const after = foregroundOwner();

			expect(saveOutcome(save)).toBe("saved");
			// A hidden session Studio runs on the user's desktop with hidden
			// windows.
			expect(save.result.data).toMatchObject({
				desktop: "user",
				pid: lockPid,
				place: fixture.place,
			});
			expect(statSync(fixture.place).mtimeMs).toBeGreaterThan(before);
			expect(after).toStrictEqual(expectedFocus(lockPid));

			const firstSavedAt = statSync(fixture.place).mtimeMs;
			const again = await runForgeAsync(fixture, ["save", "--json"], realVariables());

			expect({
				changed: statSync(fixture.place).mtimeMs > firstSavedAt,
				result: again.result,
			}).toMatchObject({ changed: true, result: { ok: true } });
		},
	);

	it(
		"dismisses delayed Compatibility lighting migration on the hidden desktop",
		{ timeout: 240_000 },
		async () => {
			expect.assertions(3);

			const fixture = await makeRealProjectAsync("compatibility.rbxl");
			const sessionId = await upStudioAsync(fixture, "hidden");
			const [, lockPid] = await waitForLoadedAsync(fixture, sessionId);
			await sleep(10_000);
			const save = await runForgeAsync(fixture, ["save", "--json"], realVariables());

			expect(saveOutcome(save)).toBe("saved");
			expect(save.result.data).toMatchObject({ desktop: "user", pid: lockPid });
			expect(foregroundOwner()).toStrictEqual(notOwnedBy(lockPid));
		},
	);

	it(
		"should open Studio directly with up --studio, and close it with down",
		{ timeout: 240_000 },
		async () => {
			expect.assertions(4);

			const fixture = await makeRealProjectAsync("saved.rbxl");
			const started = Date.now();
			const sessionId = await upStudioAsync(fixture);
			const [recorded, lockPid, pinned] = await waitForLoadedAsync(fixture, sessionId);
			const opened = Date.now();
			const down = await runForgeAsync(fixture, ["down", "--json"], realVariables());
			note({ closeMs: Date.now() - opened, openMs: opened - started, test: "down" });

			expect(recorded).toBe(lockPid);
			expect(down.result.data).toMatchObject({
				studio: { end: CLOSED_END, forced: false, pid: lockPid, status: "closed" },
			});
			await expect.poll(() => pinned.isAlive(), { timeout: 10_000 }).toBeFalse();
			expect(existsSync(`${fixture.place}.lock`)).toBeFalse();
		},
	);

	it("should close the session's Studio with stop", { timeout: 240_000 }, async () => {
		expect.assertions(2);

		const fixture = await makeRealProjectAsync("saved.rbxl");
		const sessionId = await upStudioAsync(fixture);
		const [, lockPid, pinned] = await waitForLoadedAsync(fixture, sessionId);
		const loaded = Date.now();
		const stop = await runForgeAsync(fixture, ["stop", "--json"], realVariables());
		note({ closeMs: Date.now() - loaded, test: "stop" });

		expect(stop.result.data).toMatchObject({
			end: CLOSED_END,
			forced: false,
			pid: lockPid,
			stopped: true,
		});
		await expect.poll(() => pinned.isAlive(), { timeout: 10_000 }).toBeFalse();
	});

	it(
		"should end a Studio that asks to save at once, and remove its lock file",
		{ timeout: 240_000 },
		async () => {
			expect.assertions(3);

			const fixture = await makeRealProjectAsync("unsaved.rbxl");
			const sessionId = await upStudioAsync(fixture);
			const [, lockPid, pinned] = await waitForLoadedAsync(fixture, sessionId);
			const loaded = Date.now();
			const down = await runForgeAsync(fixture, ["down", "--json"], realVariables());
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
			await expect.poll(() => pinned.isAlive(), { timeout: 10_000 }).toBeFalse();
			expect(existsSync(`${fixture.place}.lock`)).toBeFalse();
		},
	);
});
