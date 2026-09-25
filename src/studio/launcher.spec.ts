import { describe, expect, it, vi } from "vitest";

import { createFailingSpawner, createFakeSpawner } from "../../test/helpers/fake-process.ts";
import type { FakeSpawner, SpawnBehavior } from "../../test/helpers/fake-process.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import type { ManualClock } from "../../test/helpers/manual-clock.ts";
import { createTestSeams } from "../../test/helpers/seams.ts";
import type { ChildProcessRunner } from "../seams/child-process.ts";
import type { Host } from "../seams/host.ts";
import type { StudioLaunch, StudioLauncher } from "./launcher.ts";
import { createStudioLauncher, LAUNCHER_WAIT_MS, studioLaunchInvocation } from "./launcher.ts";

const WINDOWS_PLACE = "C:\\My Games\\game.rbxl";
const POSIX_PLACE = "/home/me/My Games/game.rbxl";

interface LauncherSetup {
	childProcess?: ChildProcessRunner;
	platform?: NodeJS.Platform;
}

interface Launcher {
	clock: ManualClock;
	launch: StudioLauncher;
}

function makeLauncher({
	childProcess = createFakeSpawner().runner,
	platform = "linux",
}: LauncherSetup = {}): Launcher {
	const clock = createManualClock();
	return {
		clock,
		launch: createStudioLauncher({
			childProcess,
			clock: clock.clock,
			host: { ...createTestSeams().host, kill: vi.fn<Host["kill"]>(), platform },
		}),
	};
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
			args: ["/d", "/s", "/c", `"start "" "${WINDOWS_PLACE}""`],
			file: "C:\\Windows\\cmd.exe",
			verbatimArguments: true,
		});
	});

	it("should fall back to cmd.exe when ComSpec is not set", () => {
		expect.assertions(1);

		expect(studioLaunchInvocation(WINDOWS_PLACE, "win32", {}).file).toBe("cmd.exe");
	});

	it("should open the place with open on macOS", () => {
		expect.assertions(1);

		expect(studioLaunchInvocation(POSIX_PLACE, "darwin", {})).toStrictEqual({
			args: [POSIX_PLACE],
			file: "open",
		});
	});

	it("should open the place with xdg-open on Linux", () => {
		expect.assertions(1);

		expect(studioLaunchInvocation(POSIX_PLACE, "linux", {})).toStrictEqual({
			args: [POSIX_PLACE],
			file: "xdg-open",
		});
	});
});

describe(createStudioLauncher, () => {
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

	it("should pass the Windows command line verbatim", async () => {
		expect.assertions(1);

		const spawner = spawnerExiting(0);
		const { launch } = makeLauncher({ childProcess: spawner.runner, platform: "win32" });
		await launch(launchOf(WINDOWS_PLACE));

		expect(spawner.calls[0]!.options).toMatchObject({
			detached: true,
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
