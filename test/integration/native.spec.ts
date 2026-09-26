import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import type { LockMode, NativeAddon } from "../../src/native/addon.ts";
import {
	loadRealNative,
	pidOf,
	realNativePath,
	spawnSleeper,
	waitForExitAsync,
} from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";
import { isProcessAlive } from "../helpers/worker-log.ts";

const LOCK_HOLDER = path.join(import.meta.dirname, "..", "fixtures", "bin", "lock-holder.ts");

const native: NativeAddon = loadRealNative();

function makeLockPath(): string {
	return path.join(makeTemporaryDirectory(), "test.lock");
}

function lock(lockPath: string, mode: LockMode): ReturnType<NativeAddon["tryLockFile"]> {
	const held = native.tryLockFile(lockPath, mode);
	onTestFinished(() => {
		held?.release();
	});
	return held;
}

/**
 * Start a process that holds a lock, and wait until it holds it.
 *
 * @param lockPath - The file to lock.
 * @param mode - The lock mode.
 * @returns The holder process.
 */
async function holdInChildAsync(lockPath: string, mode: LockMode): Promise<ChildProcess> {
	const child = spawn(process.execPath, [LOCK_HOLDER, realNativePath(), lockPath, mode], {
		stdio: ["ignore", "pipe", "inherit"],
		windowsHide: true,
	});
	onTestFinished(() => {
		child.kill("SIGKILL");
	});

	const [line] = await new Promise<Array<string>>((resolve) => {
		child.stdout.setEncoding("utf8");
		child.stdout.once("data", (chunk: string) => {
			resolve(chunk.split("\n"));
		});
	});
	assert(line === "locked", `the lock holder reported "${line}"`);
	return child;
}

function startTimeOf(pid: number): bigint {
	const start = native.processStartTime(pid);
	assert(start !== null, `process ${pid} has a start time`);
	return BigInt(start);
}

describe("native file locks", () => {
	it("should give an exclusive lock to one holder, without waiting", () => {
		expect.assertions(3);

		const lockPath = makeLockPath();

		expect(lock(lockPath, "exclusive")).not.toBeNull();
		expect(native.tryLockFile(lockPath, "exclusive")).toBeNull();
		expect(native.tryLockFile(lockPath, "shared")).toBeNull();
	});

	it("should share a shared lock and refuse an exclusive one", () => {
		expect.assertions(3);

		const lockPath = makeLockPath();

		expect(lock(lockPath, "shared")).not.toBeNull();
		expect(lock(lockPath, "shared")).not.toBeNull();
		expect(native.tryLockFile(lockPath, "exclusive")).toBeNull();
	});

	it("should free the lock on release", () => {
		expect.assertions(1);

		const lockPath = makeLockPath();
		lock(lockPath, "exclusive")!.release();

		expect(lock(lockPath, "exclusive")).not.toBeNull();
	});

	it("should keep the content of an existing lock file", () => {
		expect.assertions(1);

		const lockPath = makeLockPath();
		writeFileSync(lockPath, "kept");
		lock(lockPath, "exclusive")!.release();

		expect(readFileSync(lockPath, "utf8")).toBe("kept");
	});

	it("should hold a lock against other processes", async () => {
		expect.assertions(2);

		const lockPath = makeLockPath();
		await holdInChildAsync(lockPath, "shared");

		expect(lock(lockPath, "shared")).not.toBeNull();
		expect(native.tryLockFile(lockPath, "exclusive")).toBeNull();
	});

	it("should release the lock when the holder process dies", async () => {
		expect.assertions(2);

		const lockPath = makeLockPath();
		const holder = await holdInChildAsync(lockPath, "exclusive");

		expect(native.tryLockFile(lockPath, "exclusive")).toBeNull();

		holder.kill("SIGKILL");
		await waitForExitAsync(holder);

		expect(lock(lockPath, "exclusive")).not.toBeNull();
	});
});

describe("native process identity", () => {
	it("should read the same start time as the pin", () => {
		expect.assertions(1);

		const pid = pidOf(spawnSleeper());

		expect(native.pinProcess(pid)!.startTime).toBe(native.processStartTime(pid));
	});

	it("should read a later start time for a later process", () => {
		expect.assertions(1);

		const own = startTimeOf(process.pid);
		const child = startTimeOf(pidOf(spawnSleeper()));

		expect(child > own).toBeTrue();
	});

	it("should report the executable of a pinned process", () => {
		expect.assertions(1);

		const pinned = native.pinProcess(pidOf(spawnSleeper()))!;

		expect(realpathSync(pinned.executablePath()!)).toBe(realpathSync(process.execPath));
	});

	it("should kill the pinned process", async () => {
		expect.assertions(3);

		const child = spawnSleeper();
		const pinned = native.pinProcess(pidOf(child))!;

		expect(pinned.kill()).toBeTrue();
		expect(pinned.waitForExit(10_000)).toBeTrue();

		await waitForExitAsync(child);

		expect(isProcessAlive(pidOf(child))).toBeFalse();
	});

	it("should never kill through a pin whose process was reaped", async () => {
		expect.assertions(4);

		const child = spawnSleeper();
		const pinned = native.pinProcess(pidOf(child))!;
		child.kill("SIGKILL");
		await waitForExitAsync(child);
		// Started after the pinned process was reaped: it may reuse the PID.
		const later = spawnSleeper();

		expect(pinned.isAlive()).toBeFalse();
		expect(pinned.executablePath()).toBeNull();
		expect(pinned.kill()).toBeFalse();
		expect(isProcessAlive(pidOf(later))).toBeTrue();
	});

	it("should find no process for a PID that has exited", async () => {
		expect.assertions(2);

		const child = spawnSleeper();
		child.kill("SIGKILL");
		await waitForExitAsync(child);

		expect(native.processStartTime(pidOf(child))).toBeNull();
		expect(native.pinProcess(pidOf(child))).toBeNull();
	});
});
