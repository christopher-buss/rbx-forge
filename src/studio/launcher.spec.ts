import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createFailingSpawner, createFakeSpawner } from "../../test/helpers/fake-process.ts";
import type { FakeSpawner, SpawnBehavior } from "../../test/helpers/fake-process.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import type { ManualClock } from "../../test/helpers/manual-clock.ts";
import type { FakeNative } from "../../test/helpers/native.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import { createMemoryFileSystem, createTestSeams } from "../../test/helpers/seams.ts";
import type { DetachedSpawn } from "../native/addon.ts";
import type { ChildProcessRunner } from "../seams/child-process.ts";
import type { Host } from "../seams/host.ts";
import { MACOS_STUDIO_PATH, STUDIO_REGISTRY_KEYS } from "./discover.ts";
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
		launch: createStudioLauncher({
			childProcess,
			clock: clock.clock,
			fileSystem: memory.fileSystem,
			host: { ...createTestSeams().host, kill: vi.fn<Host["kill"]>(), platform },
			native: () => native.addon,
		}),
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
		expect.assertions(2);

		const spawner = spawnerExiting(0);
		const { native } = windowsNative(null);
		const { launch } = makeLauncher({
			childProcess: spawner.runner,
			files: { [STUDIO_EXE]: "" },
			native,
			platform: "win32",
		});

		await expect(launch(launchOf(WINDOWS_PLACE))).resolves.toStrictEqual({ type: "launched" });
		expect(spawner.calls[0]!.options).toMatchObject({ windowsVerbatimArguments: true });
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
			studio: { pid: 1000, startTime: "1000" },
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
