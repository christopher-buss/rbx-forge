import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { onTestFinished } from "vitest";

import type { NativeAddon } from "../../src/native/addon.ts";
import { createNativeLoader, nativeTarget, readHost } from "../../src/native/load.ts";
import { makeTemporaryDirectory } from "./temporary-directory.ts";

/**
 * Where `pnpm build:native` puts the addon. Integration and e2e tests load it
 * from here; run that script before them.
 */
export const NATIVE_DIRECTORY: string = path.join(
	import.meta.dirname,
	"..",
	"..",
	"reaper",
	"target",
	"napi",
);

/**
 * Where `pnpm build:reaper` puts the reaper binary, next to the addon.
 */
export const REAPER_PATH: string = path.join(
	NATIVE_DIRECTORY,
	process.platform === "win32" ? "forge-reaper.exe" : "forge-reaper",
);

/** Keeps a process alive until it is killed. */
const KEEP_ALIVE = "setInterval(() => {}, 60_000);";

const FAKE_WORKER = path.join(import.meta.dirname, "..", "fixtures", "bin", "fake-worker.ts");

/**
 * Load the real addon from {@link NATIVE_DIRECTORY}.
 *
 * @returns The addon.
 */
export function loadRealNative(): NativeAddon {
	return createNativeLoader({
		directory: NATIVE_DIRECTORY,
		readHost: () => readHost(process),
		requireModule: createRequire(import.meta.url),
	})();
}

/**
 * The addon file for this host, for fixture processes that load it.
 *
 * @returns Absolute path of `forge-native.<target>.node`.
 */
export function realNativePath(): string {
	return path.join(NATIVE_DIRECTORY, `forge-native.${nativeTarget(readHost(process))}.node`);
}

/**
 * Wait until a child has exited and Node has reaped it, so its PID is free.
 *
 * @param child - The child process.
 * @returns Resolves once it has exited.
 */
export async function waitForExitAsync(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}

	await new Promise<void>((resolve) => {
		child.once("exit", () => {
			resolve();
		});
	});
}

/**
 * Start a process that stays alive until the test ends.
 *
 * @param executable - The Node executable to run (a copy works too).
 * @returns The child process.
 */
export function spawnSleeper(executable: string = process.execPath): ChildProcess {
	const child = spawn(executable, ["-e", KEEP_ALIVE], { stdio: "ignore", windowsHide: true });
	// Wait for the exit: Windows cannot delete a running executable, and a
	// fake Studio runs from a temporary directory that is removed next.
	onTestFinished(async () => {
		child.kill("SIGKILL");
		await waitForExitAsync(child);
	});
	return child;
}

/**
 * An executable the OS reports as Roblox Studio: a copy of the Node
 * executable named `RobloxStudioBeta.exe` (Windows) or `RobloxStudio`
 * (macOS, Linux), in a directory removed when the test ends.
 *
 * @returns Its path.
 */
export function makeStudioExecutable(): string {
	const name = process.platform === "win32" ? "RobloxStudioBeta.exe" : "RobloxStudio";
	const executable = path.join(makeTemporaryDirectory(), name);
	copyFileSync(process.execPath, executable);
	chmodSync(executable, 0o755);
	return executable;
}

/**
 * A process whose executable the OS reports as Roblox Studio, running until
 * the test ends. It does nothing else.
 *
 * @returns The child process.
 */
export function spawnFakeStudio(): ChildProcess {
	return spawnSleeper(makeStudioExecutable());
}

/**
 * The variables that make the fixture `studio` role behave as Studio (see
 * `test/fixtures/bin/studio-stand-in.ts`), and make forge start it
 * directly.
 *
 * @param executable - A Studio executable from {@link makeStudioExecutable}.
 * @returns The variables, for forge's and the stand-in's environment.
 */
export function studioVariables(executable: string): Record<string, string> {
	return {
		FIXTURE_NATIVE_ADDON: realNativePath(),
		FIXTURE_STUDIO_EXE: executable,
		FIXTURE_STUDIO_LOCK: "1",
		RBX_FORGE_STUDIO_PATH: executable,
	};
}

/**
 * Wait until a file exists.
 *
 * @param file - Its absolute path.
 * @rejects When 30 seconds pass first.
 */
export async function waitForFileAsync(file: string): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (!existsSync(file)) {
		if (Date.now() > deadline) {
			throw new Error(`expected ${file}`);
		}

		await sleep(50);
	}
}

/**
 * Start a stand-in Studio with `place` open, and wait for its lock file. It
 * closes on a close request, unless `variables` say otherwise, and runs
 * until the test ends.
 *
 * @param place - The absolute path of the place.
 * @param variables - More fixture variables, such as
 *   `FIXTURE_STUDIO_CLOSE`.
 * @returns The child process.
 */
export async function openStudioStandInAsync(
	place: string,
	variables: Record<string, string> = {},
): Promise<ChildProcess> {
	const executable = makeStudioExecutable();
	const child = spawn(executable, [FAKE_WORKER, "studio", place], {
		env: { ...process.env, ...studioVariables(executable), ...variables },
		stdio: "ignore",
		windowsHide: true,
	});
	onTestFinished(async () => {
		child.kill("SIGKILL");
		await waitForExitAsync(child);
	});
	await waitForFileAsync(`${place}.lock`);
	return child;
}

/**
 * The PID of a started child. Fails the test when the spawn failed.
 *
 * @param child - The child process.
 * @returns Its PID.
 */
export function pidOf(child: ChildProcess): number {
	if (child.pid === undefined) {
		throw new Error("the child process did not start");
	}

	return child.pid;
}
