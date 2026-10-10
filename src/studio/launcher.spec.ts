import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { createFailingSpawner, createFakeSpawner } from "../../test/helpers/fake-process.ts";
import type { FakeSpawner, SpawnBehavior } from "../../test/helpers/fake-process.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import type { ManualClock } from "../../test/helpers/manual-clock.ts";
import type { FakeNative } from "../../test/helpers/native.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import { createMemoryFileSystem, createTestSeams } from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import type { AppLaunch, DetachedSpawn, NativeLoader } from "../native/addon.ts";
import type { ChildProcessRunner } from "../seams/child-process.ts";
import type { Host } from "../seams/host.ts";
import { findInstalledStudio, MACOS_STUDIO_PATH, STUDIO_REGISTRY_KEYS } from "./discover.ts";
import { KEEP_HIDDEN_FLAG } from "./keep-hidden.ts";
import type { StudioLaunch, StudioLauncher } from "./launcher.ts";
import {
	createStudioLauncher,
	LAUNCHER_WAIT_MS,
	PLACE_VARIABLE,
	studioLaunchInvocation,
} from "./launcher.ts";

const WINDOWS_PLACE = "C:\\My Games\\game.rbxl";
const POSIX_PLACE = "/home/me/My Games/game.rbxl";

const STUDIO_EXE = String.raw`C:\Roblox\Versions\version-1\RobloxStudioBeta.exe`;

interface LauncherSetup {
	childProcess?: ChildProcessRunner;
	/** Files that exist, by absolute path. */
	files?: Record<string, string>;
	native?: FakeNative;
	/** Replaces the addon loader. */
	nativeLoader?: NativeLoader;
	platform?: NodeJS.Platform;
}

interface Launcher {
	clock: ManualClock;
	launch: StudioLauncher;
}

function makeLauncher({
	childProcess = createFakeSpawner().runner,
	files = {},
	native = createFakeNative(),
	nativeLoader = () => native.addon,
	platform = "linux",
}: LauncherSetup = {}): Launcher {
	const clock = createManualClock();
	const memory = createMemoryFileSystem();
	for (const [file, content] of Object.entries(files)) {
		memory.fileSystem.mkdirSync(path.dirname(file), { recursive: true });
		memory.fileSystem.writeFileSync(file, content);
	}

	return {
		clock,
		launch: createStudioLauncher(
			{
				childProcess,
				clock: clock.clock,
				fileSystem: memory.fileSystem,
				host: { ...createTestSeams().host, kill: vi.fn<Host["kill"]>(), platform },
				installedStudio: findInstalledStudio,
				native: nativeLoader,
			},
			"/forge/supervisor.mjs",
		),
	};
}

/**
 * An addon whose registry names Studio, and whose detached spawn starts a
 * Studio with PID 900.
 *
 * @param pid - What `spawnDetached` returns; `null` when breakaway fails.
 * @returns The addon and every detached spawn.
 */
function windowsNative(pid: null | number = 900): {
	native: FakeNative;
	spawns: Array<DetachedSpawn>;
} {
	const native = createFakeNative(
		{ 900: { alive: true, executablePath: STUDIO_EXE, startTime: "9000" } },
		{ [STUDIO_REGISTRY_KEYS[0]!]: `"${STUDIO_EXE}" %1` },
	);
	const spawns: Array<DetachedSpawn> = [];
	Object.assign(native.addon, {
		spawnDetached: (spawn: DetachedSpawn) => {
			spawns.push(spawn);
			return pid;
		},
	});

	return { native, spawns };
}

function launchOf(place: string = POSIX_PLACE): StudioLaunch {
	return { cwd: "/project", env: { PATH: "/bin" }, place };
}

function exitWith(exitCode: null | number): SpawnBehavior {
	return (child) => {
		child.close(exitCode, exitCode === null ? "SIGKILL" : null);
	};
}

function spawnerExiting(exitCode: null | number): FakeSpawner {
	return createFakeSpawner(exitWith(exitCode));
}

describe(studioLaunchInvocation, () => {
	it("should open the place with start through the Windows shell, quoted for spaces", () => {
		expect.assertions(1);

		expect(
			studioLaunchInvocation(WINDOWS_PLACE, "win32", { ComSpec: "C:\\Windows\\cmd.exe" }),
		).toStrictEqual({
			args: ["/d", "/s", "/c", `"start "" "%${PLACE_VARIABLE}%""`],
			env: { ComSpec: "C:\\Windows\\cmd.exe", [PLACE_VARIABLE]: WINDOWS_PLACE },
			file: "C:\\Windows\\cmd.exe",
			verbatimArguments: true,
		});
	});

	it("should pass a Windows place with % in its path only through the variable", () => {
		expect.assertions(2);

		const place = String.raw`C:\Users\me\%TEMP% 100%\game.rbxl`;
		const { args, env } = studioLaunchInvocation(place, "win32", { rbx_forge_place: "old" });

		expect(args.join(" ")).not.toContain("TEMP");
		expect(env).toStrictEqual({ rbx_forge_place: place });
	});

	it("should fall back to cmd.exe when ComSpec is not set", () => {
		expect.assertions(1);

		expect(studioLaunchInvocation(WINDOWS_PLACE, "win32", {}).file).toBe("cmd.exe");
	});

	it("should open the place with open on macOS", () => {
		expect.assertions(1);

		expect(studioLaunchInvocation(POSIX_PLACE, "darwin", { HOME: "/home/me" })).toStrictEqual({
			args: [POSIX_PLACE],
			env: { HOME: "/home/me" },
			file: "open",
		});
	});

	it("should open a hidden macOS place in the background and hidden", () => {
		expect.assertions(1);

		expect(studioLaunchInvocation(POSIX_PLACE, "darwin", {}, "hidden")).toStrictEqual({
			args: ["-g", "-j", POSIX_PLACE],
			env: {},
			file: "open",
		});
	});

	it("should open the place with xdg-open on Linux", () => {
		expect.assertions(1);

		expect(studioLaunchInvocation(POSIX_PLACE, "linux", {})).toStrictEqual({
			args: [POSIX_PLACE],
			env: {},
			file: "xdg-open",
		});
	});
});

describe(createStudioLauncher, () => {
	it("should warn when a hidden Studio needs the Windows platform launcher because no executable is discovered", async () => {
		expect.assertions(1);

		const { launch } = makeLauncher({
			childProcess: spawnerExiting(0).runner,
			platform: "win32",
		});

		await expect(
			launch({ ...launchOf(WINDOWS_PLACE), desktop: "hidden" }),
		).resolves.toStrictEqual({
			desktop: "user",
			type: "launched",
			warning:
				"Studio opened on the user's desktop: the platform launcher cannot use the hidden desktop.",
		});
	});

	it("should fail with native_missing, not use the platform launcher, when the Windows addon does not load", async () => {
		expect.assertions(2);

		const spawner = spawnerExiting(0);
		const { launch } = makeLauncher({
			childProcess: spawner.runner,
			nativeLoader: () => {
				throw new ForgeError("native_missing", "no addon");
			},
			platform: "win32",
		});

		await expect(
			launch({ ...launchOf(WINDOWS_PLACE), desktop: "hidden" }),
		).rejects.toMatchObject({ code: "native_missing" });
		expect(spawner.calls).toHaveLength(0);
	});

	it("should report the user desktop without a warning for a requested user platform launch", async () => {
		expect.assertions(1);

		const { launch } = makeLauncher({
			childProcess: spawnerExiting(0).runner,
			platform: "win32",
		});

		await expect(
			launch({ ...launchOf(WINDOWS_PLACE), desktop: "user" }),
		).resolves.toStrictEqual({ desktop: "user", type: "launched" });
	});

	it("should report the user desktop and warn when a hidden launch cannot break away", async () => {
		expect.assertions(1);

		const { native } = windowsNative(null);
		const { launch } = makeLauncher({
			childProcess: spawnerExiting(0).runner,
			files: { [STUDIO_EXE]: "" },
			native,
			platform: "win32",
		});

		await expect(
			launch({ ...launchOf(WINDOWS_PLACE), desktop: "hidden" }),
		).resolves.toMatchObject({
			desktop: "user",
			type: "launched",
			warning:
				"Studio opened on the user's desktop: the platform launcher cannot use the hidden desktop.",
		});
	});

	it("should launch a hidden session on the user desktop with hidden windows", async () => {
		expect.assertions(3);

		const { native, spawns } = windowsNative();
		const spawner = createFakeSpawner();
		const { launch } = makeLauncher({
			childProcess: spawner.runner,
			files: { [STUDIO_EXE]: "" },
			native,
			platform: "win32",
		});

		await expect(
			launch({ ...launchOf(WINDOWS_PLACE), desktop: "hidden", runScript: "session.lua" }),
		).resolves.toMatchObject({ studio: { desktop: "hidden" } });
		expect(spawns[0]).toMatchObject({ desktop: "user", hiddenWindows: true });

		expect(spawner.calls[0]).toMatchObject({
			args: [
				"/forge/supervisor.mjs",
				KEEP_HIDDEN_FLAG,
				JSON.stringify({
					isWindows: true,
					pid: 900,
					place: WINDOWS_PLACE,
					startTime: "9000",
				}),
			],
			options: { detached: true, windowsHide: true },
		});
	});

	it("should launch and report a Studio on the hidden Windows desktop", async () => {
		expect.assertions(3);

		const { native, spawns } = windowsNative();
		const spawner = createFakeSpawner();
		const { launch } = makeLauncher({
			childProcess: spawner.runner,
			files: { [STUDIO_EXE]: "" },
			native,
			platform: "win32",
		});

		await expect(
			launch({ ...launchOf(WINDOWS_PLACE), desktop: "hidden" }),
		).resolves.toMatchObject({ studio: { desktop: "hidden" } });
		expect(spawns[0]).toMatchObject({ desktop: "hidden" });
		expect(spawner.calls).toStrictEqual([]);
	});

	it("should watch snapshot lighting without starting the session window watcher", async () => {
		expect.assertions(4);

		const { native, spawns } = windowsNative();
		const spawner = createFakeSpawner();
		const { launch } = makeLauncher({
			childProcess: spawner.runner,
			files: { [STUDIO_EXE]: "" },
			native,
			platform: "win32",
		});
		await launch({ ...launchOf(WINDOWS_PLACE), desktop: "hidden", watchHiddenLighting: true });

		expect(spawns).toHaveLength(2);
		expect(spawns[0]).toMatchObject({ desktop: "hidden" });
		expect(spawns[1]!.args).toStrictEqual([
			"/forge/supervisor.mjs",
			"--watch-hidden-lighting",
			JSON.stringify({ pid: 900, place: WINDOWS_PLACE, startTime: "9000" }),
		]);
		expect(spawner.calls).toStrictEqual([]);
	});

	it.for([
		{ desktop: undefined, expectedPlacement: {} },
		{ desktop: "user", expectedPlacement: { desktop: "user" } },
	] as const)(
		"should keep a shown Windows session visible with desktop %s",
		async ({ desktop, expectedPlacement }) => {
			expect.assertions(3);

			const { native, spawns } = windowsNative();
			const spawner = createFakeSpawner();
			const { launch } = makeLauncher({
				childProcess: spawner.runner,
				files: { [STUDIO_EXE]: "" },
				native,
				platform: "win32",
			});

			await expect(
				launch({ ...launchOf(WINDOWS_PLACE), desktop, runScript: "session.lua" }),
			).resolves.toMatchObject({ type: "launched" });
			expect(spawns).toStrictEqual([
				{
					args: [
						"--task",
						"RunScript",
						"--localPlaceFile",
						WINDOWS_PLACE,
						"--runScriptFile",
						"session.lua",
					],
					cwd: "/project",
					env: { PATH: "/bin" },
					program: STUDIO_EXE,
					...expectedPlacement,
				},
			]);
			expect(spawner.calls).toStrictEqual([]);
		},
	);

	it("should pass the session RunScript arguments to Studio on Windows", async () => {
		expect.assertions(1);

		const { native, spawns } = windowsNative();
		const { launch } = makeLauncher({ files: { [STUDIO_EXE]: "" }, native, platform: "win32" });
		await launch({ ...launchOf(WINDOWS_PLACE), runScript: "C:\\Session\\marker.lua" });

		expect(spawns[0]!.args).toStrictEqual([
			"--task",
			"RunScript",
			"--localPlaceFile",
			WINDOWS_PLACE,
			"--runScriptFile",
			"C:\\Session\\marker.lua",
		]);
	});

	it("should start Studio directly on Windows, out of the job, and pin it", async () => {
		expect.assertions(2);

		const { native, spawns } = windowsNative();
		const { launch } = makeLauncher({ files: { [STUDIO_EXE]: "" }, native, platform: "win32" });

		await expect(
			launch({ cwd: "/project", env: { A: "1", B: undefined }, place: WINDOWS_PLACE }),
		).resolves.toStrictEqual({ studio: { pid: 900, startTime: "9000" }, type: "launched" });
		expect(spawns).toStrictEqual([
			{ args: [WINDOWS_PLACE], cwd: "/project", env: { A: "1" }, program: STUDIO_EXE },
		]);
	});

	it("should use the platform launcher when the job forbids breakaway", async () => {
		expect.assertions(3);

		const spawner = spawnerExiting(0);
		const { native } = windowsNative(null);
		const { launch } = makeLauncher({
			childProcess: spawner.runner,
			files: { [STUDIO_EXE]: "" },
			native,
			platform: "win32",
		});
		const beforeLaunch = vi.fn<() => Promise<void>>(async () => {});

		await expect(
			launch({
				...launchOf(WINDOWS_PLACE),
				beforeLaunch,
				runScript: "C:\\Session\\marker.lua",
			}),
		).resolves.toStrictEqual({ type: "launched" });
		expect(spawner.calls[0]!.options).toMatchObject({ windowsVerbatimArguments: true });
		expect(beforeLaunch).toHaveBeenCalledOnce();
	});

	it("should finish plugin preparation before attempting a direct spawn", async () => {
		expect.assertions(2);

		const { native, spawns } = windowsNative();
		const { launch } = makeLauncher({ files: { [STUDIO_EXE]: "" }, native, platform: "win32" });
		let spawnsBeforePreparation: number | undefined;
		await launch({
			...launchOf(WINDOWS_PLACE),
			beforeLaunch: async () => {
				spawnsBeforePreparation = spawns.length;
			},
		});

		expect(spawnsBeforePreparation).toBe(0);
		expect(spawns).toHaveLength(1);
	});

	it("should prevent direct spawn when plugin preparation fails", async () => {
		expect.assertions(2);

		const { native, spawns } = windowsNative();
		const { launch } = makeLauncher({ files: { [STUDIO_EXE]: "" }, native, platform: "win32" });

		await expect(
			launch({
				...launchOf(WINDOWS_PLACE),
				beforeLaunch: async () => {
					throw new Error("plugin write failed");
				},
			}),
		).rejects.toThrow("plugin write failed");
		expect(spawns).toStrictEqual([]);
	});

	it("should bypass plugin preparation when no executable can be discovered", async () => {
		expect.assertions(2);

		const { launch } = makeLauncher({ childProcess: spawnerExiting(0).runner });
		const beforeLaunch = vi.fn<() => Promise<void>>(async () => {});

		await expect(launch({ ...launchOf(), beforeLaunch })).resolves.toStrictEqual({
			type: "launched",
		});
		expect(beforeLaunch).not.toHaveBeenCalled();
	});

	it("should bypass plugin preparation for an invalid Studio override", async () => {
		expect.assertions(2);

		const { launch } = makeLauncher();
		const beforeLaunch = vi.fn<() => Promise<void>>(async () => {});

		await expect(
			launch({ ...launchOf(), beforeLaunch, studioPath: "/missing-studio" }),
		).resolves.toMatchObject({ type: "failed" });
		expect(beforeLaunch).not.toHaveBeenCalled();
	});

	it("should use the platform launcher when the addon cannot start a detached process", async () => {
		expect.assertions(1);

		const native = createFakeNative({}, { [STUDIO_REGISTRY_KEYS[0]!]: `"${STUDIO_EXE}" %1` });
		const { launch } = makeLauncher({
			childProcess: spawnerExiting(0).runner,
			files: { [STUDIO_EXE]: "" },
			native,
			platform: "win32",
		});

		await expect(launch(launchOf(WINDOWS_PLACE))).resolves.toStrictEqual({ type: "launched" });
	});

	it("should start the macOS Studio directly, detached, with the place alone", async () => {
		expect.assertions(2);

		const spawner = createFakeSpawner();
		const native = createFakeNative({
			1000: { alive: true, executablePath: MACOS_STUDIO_PATH },
		});
		const { launch } = makeLauncher({
			childProcess: spawner.runner,
			files: { [MACOS_STUDIO_PATH]: "" },
			native,
			platform: "darwin",
		});

		await expect(launch(launchOf())).resolves.toStrictEqual({
			studio: { desktop: "user", pid: 1000, startTime: "1000" },
			type: "launched",
		});
		expect(spawner.calls[0]).toMatchObject({
			args: [POSIX_PLACE],
			file: MACOS_STUDIO_PATH,
			options: { detached: true, stdio: "ignore", windowsHide: true },
		});
	});

	it("should let forge exit without waiting for a Studio it started", async () => {
		expect.assertions(1);

		const spawner = createFakeSpawner();
		const native = createFakeNative({
			1000: { alive: true, executablePath: MACOS_STUDIO_PATH },
		});
		const { launch } = makeLauncher({
			childProcess: spawner.runner,
			files: { [MACOS_STUDIO_PATH]: "" },
			native,
			platform: "darwin",
		});
		await launch(launchOf());

		expect(spawner.children[0]!.referenced).toBeFalse();
	});

	it("should fail when Studio cannot start", async () => {
		expect.assertions(1);

		const { launch } = makeLauncher({
			childProcess: createFailingSpawner("EACCES"),
			files: { [MACOS_STUDIO_PATH]: "" },
			platform: "darwin",
		});

		await expect(launch(launchOf())).resolves.toStrictEqual({
			message: `Could not run ${MACOS_STUDIO_PATH}: spawn ${MACOS_STUDIO_PATH} EACCES`,
			type: "failed",
		});
	});

	it("should fail when Studio exits before forge pins it", async () => {
		expect.assertions(1);

		const { launch } = makeLauncher({
			childProcess: createFakeSpawner().runner,
			files: { [MACOS_STUDIO_PATH]: "" },
			platform: "darwin",
		});

		await expect(launch(launchOf())).resolves.toStrictEqual({
			message: `${MACOS_STUDIO_PATH} (PID 1000) exited at once.`,
			type: "failed",
		});
	});

	it("should fail with a hint when --studio-path names no file", async () => {
		expect.assertions(1);

		const { launch } = makeLauncher();

		await expect(
			launch({ ...launchOf(), studioPath: "/nowhere/Studio" }),
		).resolves.toStrictEqual({
			hint: "Set --studio-path to the Roblox Studio executable, or leave it unset.",
			message: "--studio-path names /nowhere/Studio, which is not a file.",
			type: "failed",
		});
	});

	it("should start the platform launcher detached, hidden, and with no pipes", async () => {
		expect.assertions(2);

		const spawner = spawnerExiting(0);
		const { launch } = makeLauncher({ childProcess: spawner.runner });

		await expect(launch(launchOf())).resolves.toStrictEqual({ type: "launched" });
		expect(spawner.calls).toStrictEqual([
			{
				args: [POSIX_PLACE],
				file: "xdg-open",
				options: {
					cwd: "/project",
					detached: true,
					env: { PATH: "/bin" },
					stdio: "ignore",
					windowsHide: true,
					windowsVerbatimArguments: false,
				},
			},
		]);
	});

	it("should pass the Windows command line verbatim, with the place in its environment", async () => {
		expect.assertions(1);

		const spawner = spawnerExiting(0);
		const { launch } = makeLauncher({ childProcess: spawner.runner, platform: "win32" });
		await launch(launchOf(WINDOWS_PLACE));

		expect(spawner.calls[0]!.options).toMatchObject({
			detached: true,
			env: { PATH: "/bin", [PLACE_VARIABLE]: WINDOWS_PLACE },
			windowsVerbatimArguments: true,
		});
	});

	it("should let forge exit without waiting for the launcher", async () => {
		expect.assertions(1);

		const spawner = spawnerExiting(0);
		const { launch } = makeLauncher({ childProcess: spawner.runner });
		await launch(launchOf());

		expect(spawner.children[0]!.referenced).toBeFalse();
	});

	it("should fail when the launcher exits with an error", async () => {
		expect.assertions(1);

		const { launch } = makeLauncher({ childProcess: spawnerExiting(4).runner });

		await expect(launch(launchOf())).resolves.toStrictEqual({
			message: "xdg-open exited with code 4.",
			type: "failed",
		});
	});

	it("should fail when a signal ends the launcher", async () => {
		expect.assertions(1);

		const { launch } = makeLauncher({ childProcess: spawnerExiting(null).runner });

		await expect(launch(launchOf())).resolves.toStrictEqual({
			message: "xdg-open was ended by SIGKILL.",
			type: "failed",
		});
	});

	it("should fail when the launcher cannot start", async () => {
		expect.assertions(1);

		const { launch } = makeLauncher({ childProcess: createFailingSpawner("ENOENT") });

		await expect(launch(launchOf())).resolves.toStrictEqual({
			message: "Could not run xdg-open: spawn xdg-open ENOENT",
			type: "failed",
		});
	});

	it("should stop waiting for a launcher that keeps running and count it as launched", async () => {
		expect.assertions(2);

		const spawner = createFakeSpawner();
		const { clock, launch } = makeLauncher({ childProcess: spawner.runner });
		const launched = launch(launchOf());
		await new Promise((resolve) => {
			setImmediate(resolve);
		});
		clock.advance(LAUNCHER_WAIT_MS);

		await expect(launched).resolves.toStrictEqual({ type: "launched" });
		expect(spawner.children[0]!.referenced).toBeFalse();
	});

	it("should clear the wait timer once the launcher exits", async () => {
		expect.assertions(1);

		const { clock, launch } = makeLauncher({ childProcess: spawnerExiting(0).runner });
		await launch(launchOf());

		expect(clock.pending()).toBe(0);
	});
});

const MACOS_BUNDLE = "/Applications/RobloxStudio.app";

/**
 * A macOS addon whose LaunchServices launch starts a Studio with PID 1000.
 *
 * @param result - What `launchApplication` does: a PID, or an error to reject with.
 * @returns The addon and every launch.
 */
function macosNative(result: Error | number = 1000): {
	launches: Array<AppLaunch>;
	native: FakeNative;
} {
	const native = createFakeNative({
		1000: { alive: true, executablePath: MACOS_STUDIO_PATH },
	});
	const launches: Array<AppLaunch> = [];
	Object.assign(native.addon, {
		launchApplication: async (launch: AppLaunch) => {
			launches.push(launch);
			if (result instanceof Error) {
				throw result;
			}

			return result;
		},
	});
	return { launches, native };
}

describe("macOS Studio launch", () => {
	it("should launch a hidden Studio through LaunchServices, never activated, and keep it hidden", async () => {
		expect.assertions(3);

		const spawner = createFakeSpawner();
		const { launches, native } = macosNative();
		const { launch } = makeLauncher({
			childProcess: spawner.runner,
			files: { [MACOS_STUDIO_PATH]: "" },
			native,
			platform: "darwin",
		});

		await expect(launch({ ...launchOf(), desktop: "hidden" })).resolves.toStrictEqual({
			studio: { desktop: "hidden", pid: 1000, startTime: "1000" },
			type: "launched",
		});
		expect(launches).toStrictEqual([
			{
				activates: false,
				args: [POSIX_PLACE],
				bundle: MACOS_BUNDLE,
				env: { PATH: "/bin" },
				hides: true,
			},
		]);
		expect(spawner.calls).toMatchObject([
			{
				args: [
					"/forge/supervisor.mjs",
					KEEP_HIDDEN_FLAG,
					JSON.stringify({ pid: 1000, place: POSIX_PLACE, startTime: "1000" }),
				],
				options: { detached: true },
			},
		]);
	});

	it("should launch a user Studio through LaunchServices, activated, with the RunScript task", async () => {
		expect.assertions(3);

		const spawner = createFakeSpawner();
		const { launches, native } = macosNative();
		const { launch } = makeLauncher({
			childProcess: spawner.runner,
			files: { [MACOS_STUDIO_PATH]: "" },
			native,
			platform: "darwin",
		});

		await expect(
			launch({ ...launchOf(), desktop: "user", runScript: "/project/run.lua" }),
		).resolves.toStrictEqual({
			studio: { desktop: "user", pid: 1000, startTime: "1000" },
			type: "launched",
		});
		expect(launches[0]).toMatchObject({
			activates: true,
			args: [
				"--task",
				"RunScript",
				"--localPlaceFile",
				POSIX_PLACE,
				"--runScriptFile",
				"/project/run.lua",
			],
			hides: false,
		});
		expect(spawner.calls).toHaveLength(0);
	});

	it("should launch Studio activated through LaunchServices when no desktop is requested", async () => {
		expect.assertions(2);

		const { launches, native } = macosNative();
		const { launch } = makeLauncher({
			files: { [MACOS_STUDIO_PATH]: "" },
			native,
			platform: "darwin",
		});

		await expect(launch(launchOf())).resolves.toStrictEqual({
			studio: { desktop: "user", pid: 1000, startTime: "1000" },
			type: "launched",
		});
		expect(launches[0]).toMatchObject({ activates: true, hides: false });
	});

	it("should fail when LaunchServices cannot launch Studio", async () => {
		expect.assertions(1);

		const { native } = macosNative(new Error("launch denied"));
		const { launch } = makeLauncher({
			files: { [MACOS_STUDIO_PATH]: "" },
			native,
			platform: "darwin",
		});

		await expect(launch({ ...launchOf(), desktop: "hidden" })).resolves.toStrictEqual({
			message: `Could not launch ${MACOS_BUNDLE}: launch denied`,
			type: "failed",
		});
	});

	it("should warn when the watcher that keeps Studio hidden cannot start", async () => {
		expect.assertions(1);

		const { native } = macosNative();
		const { launch } = makeLauncher({
			childProcess: {
				spawn: () => {
					throw new Error("spawn EINVAL");
				},
			},
			files: { [MACOS_STUDIO_PATH]: "" },
			native,
			platform: "darwin",
		});

		const outcome = await launch({ ...launchOf(), desktop: "hidden" });
		assert(outcome.type === "launched");

		expect(outcome.warning).toContain("the watcher that keeps it hidden could not start");
	});

	it("should start an executable outside an app bundle directly and report the user desktop with a warning", async () => {
		expect.assertions(2);

		const executable = "/opt/studio/RobloxStudio";
		const spawner = createFakeSpawner();
		const { launches, native } = macosNative();
		const { launch } = makeLauncher({
			childProcess: spawner.runner,
			files: { [executable]: "" },
			native,
			platform: "darwin",
		});

		await expect(
			launch({ ...launchOf(), desktop: "hidden", studioPath: executable }),
		).resolves.toStrictEqual({
			studio: { desktop: "user", pid: 1000, startTime: "1000" },
			type: "launched",
			warning:
				"Studio opened on the user's desktop: its executable is not in an app bundle LaunchServices can open hidden.",
		});
		expect(launches).toHaveLength(0);
	});

	it("should start a hidden Studio directly on Linux, never through LaunchServices, without a warning", async () => {
		expect.assertions(2);

		const { launches, native } = macosNative();
		const { launch } = makeLauncher({ files: { [MACOS_STUDIO_PATH]: "" }, native });

		await expect(
			launch({ ...launchOf(), desktop: "hidden", studioPath: MACOS_STUDIO_PATH }),
		).resolves.toStrictEqual({
			studio: { desktop: "user", pid: 1000, startTime: "1000" },
			type: "launched",
		});
		expect(launches).toHaveLength(0);
	});

	it("should open a hidden place in the background with the platform launcher and warn that it may not stay hidden", async () => {
		expect.assertions(2);

		const spawner = spawnerExiting(0);
		const { launch } = makeLauncher({ childProcess: spawner.runner, platform: "darwin" });

		await expect(launch({ ...launchOf(), desktop: "hidden" })).resolves.toStrictEqual({
			desktop: "user",
			type: "launched",
			warning:
				"Studio opened in the background, but the platform launcher cannot keep it hidden.",
		});
		expect(spawner.calls[0]).toMatchObject({ args: ["-g", "-j", POSIX_PLACE], file: "open" });
	});
});
