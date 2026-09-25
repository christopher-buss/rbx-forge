import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
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

/** Keeps a process alive until it is killed. */
const KEEP_ALIVE = "setInterval(() => {}, 60_000);";

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
 * A process whose executable the OS reports as Roblox Studio: a copy of the
 * Node executable named `RobloxStudioBeta.exe` (Windows) or `RobloxStudio`
 * (macOS, Linux), running until the test ends.
 *
 * @returns The child process.
 */
export function spawnFakeStudio(): ChildProcess {
	const name = process.platform === "win32" ? "RobloxStudioBeta.exe" : "RobloxStudio";
	const executable = path.join(makeTemporaryDirectory(), name);
	copyFileSync(process.execPath, executable);
	chmodSync(executable, 0o755);
	return spawnSleeper(executable);
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
