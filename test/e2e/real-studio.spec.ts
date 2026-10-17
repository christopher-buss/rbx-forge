/**
 * Opt-in, local only: `up`, `down`, and `stop` against the real Roblox Studio
 * of this computer. It runs only with `RBX_FORGE_TEST_REAL_STUDIO=1` on
 * Windows with Studio installed and logged in, and genuine Rojo 7.7.1 (see
 * `genuineRojo`); CI never runs it. It opens Studio windows on the desktop.
 *
 * Each test cleans up only the Studio returned by its launcher or recorded
 * in its session, through a PID and start-time pin. Each fixture runs a copied
 * built CLI with private plugin filenames and marker names. Its plugins stay
 * gated until its own launch script runs; canonical plugins stay unchanged.
 *
 * Places (`test/fixtures/studio/`):
 *
 * - `saved.rbxl`: Studio saved the `rojo build` of `unsaved.project.json`.
 *   Current Studio and plugins may update it on load; graceful-close cases
 *   save their owned copy after readiness to establish a clean baseline.
 * - `unsaved.rbxl`: `rojo build unsaved.project.json`. Studio always takes a
 *   place fresh from Rojo as changed, so it asks to save on close.
 *   `Lighting.Technology` is set, so no Lighting migration dialog shows.
 *
 * Timings go to `RBX_FORGE_TEST_REAL_STUDIO_LOG` (NDJSON), when set.
 */
// cspell:words pcall
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
import type { TestContext } from "vitest";
import { assert, describe, it, expect as matchers } from "vitest";

import type { PinnedProcess } from "../../src/native/addon.ts";
import { parseStatus } from "../../src/session/status.ts";
import { captureRealStudioFixtureAsync } from "../helpers/capture-real-studio-fixture.ts";
import type { IsolatedRealStudioCli } from "../helpers/isolated-real-studio-cli.ts";
import { isolatedRealStudioFixtureAsync } from "../helpers/isolated-real-studio-fixture.ts";
import { parseLines, parseOpened } from "../helpers/output.ts";
import { loadRealNative } from "../helpers/real-native.ts";
import { studioCleanup } from "../helpers/real-studio-cleanup.ts";
import { genuineRojo } from "../helpers/real-studio-sync-fixture.ts";
import { pinNow } from "../helpers/worker-log.ts";
import type { Fixture } from "./session-fixture.ts";
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
const CLOSED_END: unknown = matchers.toBeOneOf(["exited", "lock_released"]);

interface RealFixture extends Fixture {
	cli: IsolatedRealStudioCli;
}

/**
 * The real Plugins folder, where every fixture uses unique filenames.
 *
 * @returns Its path.
 */
function realPluginsDirectory(): string {
	const home = env["RBX_FORGE_TEST_REAL_USERPROFILE"] ?? "";
	return path.join(home, "AppData/Local/Roblox/Plugins");
}

async function makeRealFixtureAsync(
	config: Record<string, unknown> = {},
	sharedCli?: IsolatedRealStudioCli,
): Promise<RealFixture> {
	return isolatedRealStudioFixtureAsync({
		config,
		pluginsDirectory: realPluginsDirectory(),
		...(sharedCli === undefined ? {} : { sharedCli }),
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
async function makeRealProjectAsync(fixturePlace: string): Promise<RealFixture> {
	const fixture = await makeRealFixtureAsync({
		buildOutputPath: PLACE,
		open: { buildFirst: false },
	});
	copyFileSync(path.join(PLACES, fixturePlace), path.join(fixture.project, PLACE));
	return { ...fixture, place: path.join(fixture.project, PLACE) };
}

async function compatibilitySnapshotAsync(
	fixturePlace = "compatibility.rbxl",
	sharedCli?: IsolatedRealStudioCli,
): Promise<RealFixture> {
	const fixture = await makeRealFixtureAsync({ projectType: "luau" }, sharedCli);
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
	const own = studioCleanup(fixture.project);
	const up = await runForgeAsync(
		fixture,
		["up", "--studio", "--desktop", desktop, "--json"],
		realVariables(),
	);
	note({
		command: "up --studio",
		project: fixture.project,
		stderr: up.stderr,
		stdout: up.stdout,
	});
	assert(up.status === 0 && up.result.data !== undefined, up.stdout);
	const sessionId = String(up.result.data["sessionId"]);
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
 * @param quietMs - Time without modal dialogs; capture needs no menu readiness.
 * @returns The PID the session recorded, the lock PID and its verified pin.
 * @rejects When Studio does not open the place in time.
 */
async function waitForLoadedAsync(
	fixture: Fixture,
	sessionId: string,
	quietMs = QUIET_MS,
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
	while (Date.now() - quietSince < quietMs) {
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
 * @param testContext - Assertions and cleanup for this test.
 * @param studio - The Studio PID.
 * @returns A matcher for {@link foregroundOwner}.
 */
function notOwnedBy(testContext: Pick<TestContext, "expect">, studio: number): unknown {
	return testContext.expect.toSatisfy((owner: number) => owner !== studio);
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

function hasRunForgePlugin(place: string, plugin: string): boolean {
	return studioLogLines(place).some((line) => {
		return line.includes(`loadPlugin user_${path.basename(plugin)}`);
	});
}

/**
 * Open a saved snapshot on the hidden desktop; the test's end stops its Studio.
 *
 * @param sharedCli - The private installation reused by the second launch.
 * @returns The snapshot, and the installed forge plugin's modification time.
 */
async function openPluginSnapshotAsync(sharedCli?: IsolatedRealStudioCli): Promise<{
	cli: IsolatedRealStudioCli;
	place: string;
	pluginModified: number;
}> {
	const fixture = await compatibilitySnapshotAsync("saved.rbxl", sharedCli);
	const pin = studioCleanup();
	const opened = await runForgeAsync(
		fixture,
		["open", "--desktop", "hidden", "--json"],
		realVariables(),
	);
	const { place, studio } = parseOpened(opened.result.data);
	assert(opened.status === 0 && studio !== null, JSON.stringify(opened.result));
	pin(studio);
	const { mtimeMs, size } = statSync(fixture.cli.installedPlugin);
	note({ command: "forge-plugin-open", plugin: size, result: opened.result });
	return { cli: fixture.cli, place, pluginModified: mtimeMs };
}

/**
 * Lines in which Studio reads and loads a user plugin, and restores its IDE
 * state.
 */
const PLUGIN_LOAD_LINE =
	/\[FLog::(?:PluginFileRead|PluginLoadingEnhanced|PluginDebugState)\] (?:Hashing Plugin '|Plugin file read '|loadPlugin |Restoring (?:IDE|debugger) state for plugin `)user_/u;

function saveOutcome(run: UpRun): string {
	return run.status === 0 ? "saved" : JSON.stringify(run.result);
}

async function captureForgeAsync(fixture: Fixture, argv: Array<string>): Promise<UpRun> {
	const run = await runForgeAsync(fixture, argv, realVariables());
	note({ command: argv, project: fixture.project, stderr: run.stderr, stdout: run.stdout });
	return run;
}

describe.skipIf(!IS_ENABLED)("real Roblox Studio", () => {
	it(
		"names generated protected-property history and collision-group changes once per session",
		{ timeout: 240_000 },
		async ({ expect, onTestFinished }) => {
			expect.assertions(7);

			const fixture = await makeRealFixtureAsync({ studio: { saveMethod: "capture" } });
			const editor = await captureRealStudioFixtureAsync({
				actions: {
					warnings: `local readable = pcall(function() return workspace.PhysicsSteppingMethod end)
assert(not readable, "PhysicsSteppingMethod must be protected in this Studio")
game:GetService("Selection"):Set({ workspace })
local history = game:GetService("ChangeHistoryService")
local recording = history:TryBeginRecording("PhysicsSteppingMethod", "PhysicsSteppingMethod")
assert(recording, "The fixture must create an engine undo recording")
local folder = Instance.new("Folder")
folder.Name = "ForgeGeneratedWarningWaypoint"
folder.Parent = workspace
history:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
local canUndo, name = history:GetCanUndo()
assert(canUndo and name == "PhysicsSteppingMethod", "The generated waypoint must name the protected property: " .. tostring(name))
local physics = game:GetService("PhysicsService")
physics:RegisterCollisionGroup("ForgeCaptureWarningGroup")
assert(physics:IsCollisionGroupRegistered("ForgeCaptureWarningGroup"))
task.wait(0.1)`,
				},
				captureName: fixture.cli.captureName,
				directory: fixture.project,
				native: loadRealNative(),
				pluginsDirectory: realPluginsDirectory(),
			});
			onTestFinished(editor.closeAsync);
			writeFileSync(
				path.join(fixture.project, "default.project.json"),
				JSON.stringify({
					name: "forge-real-warning-capture",
					tree: {
						$attributes: {
							...editor.launchAttributes,
							...fixture.cli.launchAttributes,
						},
						$className: "DataModel",
						Lighting: { $properties: { Technology: "ShadowMap" } },
						Workspace: { $className: "Workspace" },
					},
				}),
			);
			const sessionId = await upStudioAsync(fixture, "hidden");
			const [, pid, pinned] = await waitForLoadedAsync(fixture, sessionId, 0);
			editor.own(pinned);
			await editor.waitForCaptureUrlAsync();
			const baseline = await captureForgeAsync(fixture, ["save", "--json"]);

			expect(baseline).toMatchObject({ result: { data: { warnings: [] } }, status: 0 });

			const observation = await editor.runAsync("warnings");
			note({
				command: "generated-warning-waypoint-and-collision-group",
				pid,
				startTime: pinned.startTime,
				studioVersion: observation.version,
			});
			const saved = await captureForgeAsync(fixture, ["save", "--json"]);
			assert(saved.result.data !== undefined, "capture save returns data");
			const unreadable = {
				property: "PhysicsSteppingMethod",
				reason: "unreadable",
				service: "Workspace",
			};
			const collisions = {
				property: "CollisionGroups",
				reason: "collision_groups",
				service: "Workspace",
			};

			expect(saved).toMatchObject({
				result: { data: { pid, place: fixture.place } },
				status: 0,
			});
			expect(saved.result.data["warnings"]).toIncludeSameMembers([unreadable, collisions]);
			expect(parseLines(saved.stdout)).toContainEqual({
				...unreadable,
				message:
					"Workspace.PhysicsSteppingMethod cannot be captured; set it in the project file.",
				type: "warning",
			});
			expect(parseLines(saved.stdout)).toContainEqual({
				...collisions,
				message:
					"Workspace.CollisionGroups cannot be captured; set it in the project file.",
				type: "warning",
			});

			const repeated = await captureForgeAsync(fixture, ["save", "--json"]);

			expect(repeated).toMatchObject({ result: { data: { warnings: [] } }, status: 0 });
			expect(parseLines(repeated.stdout)).not.toContainEqual(
				expect.objectContaining({ type: "warning" }),
			);
		},
	);

	it(
		"captures Studio edits and reconnects a Found Studio after a session restart",
		{ timeout: 360_000 },
		async ({ expect, onTestFinished }) => {
			expect.assertions(15);

			const fixture = await makeRealFixtureAsync({
				studio: { saveMethod: "capture" },
			});
			const editor = await captureRealStudioFixtureAsync({
				actions: {
					first: `local capture = game:GetService("ServerStorage"):FindFirstChild("ForgeCapture")
assert(capture and not capture.Archivable, "Session capture instance must be non-Archivable")
local part = Instance.new("Part")
part.Name = "ForgeCapturedFirstPart"
part.Anchored = true
part.Parent = workspace
game:GetService("ServerScriptService").CaptureScript.Source = 'print("captured first edit")\\n'
local lighting = game:GetService("Lighting")
lighting.ClockTime = 13.5
lighting:SetAttribute("CapturedServiceEdit", "first")
lighting:AddTag("captured-service")`,
					second: `local part = Instance.new("Part")
part.Name = "ForgeCapturedAfterRestartPart"
part.Anchored = true
part.Parent = workspace
game:GetService("ServerScriptService").CaptureScript.Source = 'print("captured after restart")\\n'
local lighting = game:GetService("Lighting")
lighting.ClockTime = 15.25
lighting:SetAttribute("CapturedServiceEdit", "second")`,
				},
				captureName: fixture.cli.captureName,
				directory: fixture.project,
				native: loadRealNative(),
				pluginsDirectory: realPluginsDirectory(),
			});
			onTestFinished(editor.closeAsync);
			mkdirSync(path.join(fixture.project, "workspace"));
			mkdirSync(path.join(fixture.project, "scripts"));
			const script = path.join(fixture.project, "scripts", "CaptureScript.server.luau");
			writeFileSync(script, 'print("original capture script")\n');
			writeFileSync(
				path.join(fixture.project, "default.project.json"),
				JSON.stringify({
					name: "forge-real-capture",
					tree: {
						$attributes: {
							...editor.launchAttributes,
							...fixture.cli.launchAttributes,
						},
						$className: "DataModel",
						Lighting: { $properties: { ClockTime: 9, Technology: "ShadowMap" } },
						ServerScriptService: { $path: "scripts" },
						Workspace: { $path: "workspace" },
					},
				}),
			);
			const sessionId = await upStudioAsync(fixture, "hidden");
			const [, pid, pinned] = await waitForLoadedAsync(fixture, sessionId, 0);
			editor.own(pinned);
			const initial = await editor.runAsync("first");
			note({
				command: "capture-edit",
				pid,
				sequence: initial.sequence,
				studioVersion: initial.version,
			});

			const saved = await captureForgeAsync(fixture, ["save", "--json"]);

			expect(saved).toMatchObject({
				result: { data: { desktop: "user", pid, place: fixture.place } },
				status: 0,
			});

			const synced = await captureForgeAsync(fixture, ["syncback", "--json"]);

			expect(synced.status).toBe(0);
			expect(
				JSON.parse(
					readFileSync(path.join(fixture.project, "default.project.json"), "utf8"),
				),
			).toMatchObject({
				tree: {
					Lighting: {
						$attributes: { CapturedServiceEdit: "first" },
						$properties: {
							ClockTime: 13.5,
							Tags: ["captured-service"],
							Technology: "ShadowMap",
						},
					},
				},
			});
			expect(readFileSync(script, "utf8")).toContain('print("captured first edit")');
			expect(
				existsSync(path.join(fixture.project, "workspace/ForgeCapturedFirstPart.rbxm")),
			).toBeTrue();

			const down = await captureForgeAsync(fixture, ["down", "--keep-studio", "--json"]);

			expect(down.status).toBe(0);
			expect(pinned.isAlive()).toBeTrue();

			const restarted = await upStudioAsync(fixture, "hidden");
			const [, foundPid] = await waitForLoadedAsync(fixture, restarted, 0);

			expect(restarted).not.toBe(sessionId);
			expect(foundPid).toBe(pid);

			const foundStatus = await captureForgeAsync(fixture, ["status", "--json"]);

			expect(foundStatus.result.data).toMatchObject({
				services: { studio: { origin: "found", pid } },
			});

			await editor.waitForCaptureUrlAsync(initial.captureUrl);
			await editor.runAsync("second");
			const savedAgain = await captureForgeAsync(fixture, ["save", "--json"]);

			expect(savedAgain.status).toBe(0);

			const syncedAgain = await captureForgeAsync(fixture, ["syncback", "--json"]);

			expect(syncedAgain.status).toBe(0);
			expect(
				JSON.parse(
					readFileSync(path.join(fixture.project, "default.project.json"), "utf8"),
				),
			).toMatchObject({
				tree: {
					Lighting: {
						$attributes: { CapturedServiceEdit: "second" },
						$properties: {
							ClockTime: 15.25,
							Tags: ["captured-service"],
							Technology: "ShadowMap",
						},
					},
				},
			});
			expect(readFileSync(script, "utf8")).toContain('print("captured after restart")');
			expect(
				existsSync(
					path.join(fixture.project, "workspace/ForgeCapturedAfterRestartPart.rbxm"),
				),
			).toBeTrue();

			note({
				command: "capture-files",
				files: readdirSync(path.join(fixture.project, "workspace")),
				pid,
				project: fixture.project,
				script: readFileSync(script, "utf8"),
				startTime: pinned.startTime,
			});
		},
	);

	it(
		"dismisses hidden snapshot Compatibility lighting after the open CLI exits",
		{ timeout: 150_000 },
		async ({ expect }) => {
			expect.assertions(5);

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
				.poll(() => Number(readFileSync(`${place}.lock`, "utf8").split(/\r?\n/, 1)[0]), {
					interval: 100,
					timeout: OPEN_MS,
				})
				.toBe(studio.pid);

			await sleep(10_000);

			await expect
				.poll(() => pinned.isBlocked(), { interval: 500, timeout: 30_000 })
				.toBeFalse();
			expect(pinned.isAlive()).toBeTrue();
			expect(foregroundOwner()).toStrictEqual(notOwnedBy({ expect }, studio.pid));
		},
	);

	it(
		"installs the forge plugin, which Studio loads and which stays inert",
		{ timeout: 300_000 },
		async ({ expect }) => {
			expect.assertions(7);

			const first = await openPluginSnapshotAsync();
			const second = await openPluginSnapshotAsync(first.cli);

			expect(readFileSync(first.cli.installedPlugin)).toStrictEqual(
				readFileSync(first.cli.bundledPlugin),
			);
			// The second launch found a current copy and left it unwritten.
			expect(second.pluginModified).toBe(first.pluginModified);

			await expect
				.poll(() => hasRunForgePlugin(first.place, first.cli.installedPlugin), {
					interval: 500,
					timeout: OPEN_MS,
				})
				.toBeTrue();
			await expect
				.poll(() => existsSync(`${first.place}.lock`), { interval: 100, timeout: OPEN_MS })
				.toBeTrue();

			await sleep(QUIET_MS);
			const lines = studioLogLines(first.place);
			const mentions = lines.filter((line) => {
				return line.includes(path.basename(first.cli.installedPlugin));
			});

			expect(mentions).not.toBeEmpty();
			expect(mentions.filter((line) => !PLUGIN_LOAD_LINE.test(line))).toStrictEqual([]);
			expect(lines.filter((line) => line.includes(first.cli.captureName))).toStrictEqual([]);
		},
	);

	it(
		"shows, hides, and saves the same session Studio while hidden",
		{ timeout: 600_000 },
		async ({ expect }) => {
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
			expectedFocus: ({ expect }: Pick<TestContext, "expect">, _studio: number): unknown => {
				return expect.any(Number);
			},
		},
		{ desktop: "hidden", expectedFocus: notOwnedBy },
	] as const)(
		"saves Studio on the $desktop desktop",
		{ timeout: 240_000 },
		async ({ desktop, expectedFocus }, { expect }) => {
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
			note({ command: "save", result: save.result, status: save.status });
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
			expect(after).toStrictEqual(expectedFocus({ expect }, lockPid));

			const firstSavedAt = statSync(fixture.place).mtimeMs;
			const again = await runForgeAsync(fixture, ["save", "--json"], realVariables());
			note({ command: "save-again", result: again.result, status: again.status });

			expect({
				changed: statSync(fixture.place).mtimeMs > firstSavedAt,
				result: again.result,
			}).toMatchObject({ changed: true, result: { ok: true } });
		},
	);

	it(
		"dismisses delayed Compatibility lighting migration on the hidden desktop",
		{ timeout: 240_000 },
		async ({ expect }) => {
			expect.assertions(3);

			const fixture = await makeRealProjectAsync("compatibility.rbxl");
			const sessionId = await upStudioAsync(fixture, "hidden");
			const [, lockPid] = await waitForLoadedAsync(fixture, sessionId);
			await sleep(10_000);
			const save = await runForgeAsync(fixture, ["save", "--json"], realVariables());

			expect(saveOutcome(save)).toBe("saved");
			expect(save.result.data).toMatchObject({ desktop: "user", pid: lockPid });
			expect(foregroundOwner()).toStrictEqual(notOwnedBy({ expect }, lockPid));
		},
	);

	it(
		"should open Studio directly with up --studio, and close it with down",
		{ timeout: 240_000 },
		async ({ expect }) => {
			expect.assertions(5);

			const fixture = await makeRealProjectAsync("saved.rbxl");
			const started = Date.now();
			const sessionId = await upStudioAsync(fixture);
			const [recorded, lockPid, pinned] = await waitForLoadedAsync(fixture, sessionId);
			const opened = Date.now();
			const saved = await runForgeAsync(fixture, ["save", "--json"], realVariables());
			note({ command: "prepare-down", result: saved.result, status: saved.status });

			expect(saveOutcome(saved)).toBe("saved");

			const closing = Date.now();
			const down = await runForgeAsync(fixture, ["down", "--json"], realVariables());
			note({ closeMs: Date.now() - closing, openMs: opened - started, test: "down" });

			expect(recorded).toBe(lockPid);
			expect(down.result.data).toMatchObject({
				studio: { end: CLOSED_END, forced: false, pid: lockPid, status: "closed" },
			});
			await expect.poll(() => pinned.isAlive(), { timeout: 10_000 }).toBeFalse();
			expect(existsSync(`${fixture.place}.lock`)).toBeFalse();
		},
	);

	it("should close the session's Studio with stop", { timeout: 240_000 }, async ({ expect }) => {
		expect.assertions(3);

		const fixture = await makeRealProjectAsync("saved.rbxl");
		const sessionId = await upStudioAsync(fixture);
		const [, lockPid, pinned] = await waitForLoadedAsync(fixture, sessionId);
		const saved = await runForgeAsync(fixture, ["save", "--json"], realVariables());
		note({ command: "prepare-stop", result: saved.result, status: saved.status });

		expect(saveOutcome(saved)).toBe("saved");

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
		async ({ expect }) => {
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
