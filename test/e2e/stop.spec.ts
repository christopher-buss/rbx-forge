import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { EXIT_FAILURE, EXIT_IDENTITY_UNVERIFIED, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import { parseResult } from "../helpers/output.ts";
import {
	NATIVE_DIRECTORY,
	pidOf,
	spawnFakeStudio,
	spawnSleeper,
	waitForExitAsync,
} from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";
import { isProcessAlive } from "../helpers/worker-log.ts";
import { makeProject, runBinAsync } from "./run-bin.ts";

/**
 * This process's variables, without `CI`, with the native addon directory set.
 *
 * @param directory - Where forge loads the native addon from.
 * @returns The run's variables.
 */
function nativeEnvironment(directory: string): NodeJS.ProcessEnv {
	return { ...process.env, CI: undefined, RBX_FORGE_NATIVE_DIR: directory };
}

const NATIVE = nativeEnvironment(NATIVE_DIRECTORY);

/**
 * Make a project whose place has a Studio lock file.
 *
 * @param pid - The PID the lock file names.
 * @param host - The computer the lock file names.
 * @returns The project, its place, and the lock file.
 */
function makeLockedProject(
	pid: number,
	host = os.hostname(),
): { lockPath: string; place: string; project: string } {
	const project = makeProject({ "rbx-forge.config.json": '{ "projectType": "luau" }' });
	const place = path.join(project, "game.rbxl");
	const lockPath = `${place}.lock`;
	writeFileSync(
		lockPath,
		`${pid}\nRobloxStudioBeta\n${host}\n00000000-0000-0000-0000-000000000000\n\n`,
	);
	return { lockPath, place, project };
}

describe("forge stop", () => {
	it("should kill a verified Studio and remove its lock file", async () => {
		expect.assertions(4);

		const studio = spawnFakeStudio();
		const pid = pidOf(studio);
		const { lockPath, place, project } = makeLockedProject(pid);
		const { status, stdout } = await runBinAsync(["stop", "--json"], project, NATIVE);
		await waitForExitAsync(studio);

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseResult(stdout).data).toStrictEqual({ pid, place, stopped: true });
		expect(existsSync(lockPath)).toBeFalse();
		expect(isProcessAlive(pid)).toBeFalse();
	});

	it("should kill nothing when a stale lock names a PID that another program reused", async () => {
		expect.assertions(4);

		const pid = pidOf(spawnSleeper());
		const { lockPath, project } = makeLockedProject(pid);
		const lockFile = readFileSync(lockPath, "utf8");
		const { status, stdout } = await runBinAsync(["stop", "--json"], project, NATIVE);

		expect(status).toBe(EXIT_IDENTITY_UNVERIFIED);
		expect(parseResult(stdout).error!.code).toBe("identity_mismatch");
		expect(isProcessAlive(pid)).toBeTrue();
		expect(readFileSync(lockPath, "utf8")).toBe(lockFile);
	});

	it("should kill nothing when the lock file was written on another computer", async () => {
		expect.assertions(4);

		const pid = pidOf(spawnFakeStudio());
		const { lockPath, project } = makeLockedProject(pid, "ANOTHER-COMPUTER");
		const { status, stdout } = await runBinAsync(["stop", "--json"], project, NATIVE);

		expect(status).toBe(EXIT_IDENTITY_UNVERIFIED);
		expect(parseResult(stdout).error!.code).toBe("identity_mismatch");
		expect(isProcessAlive(pid)).toBeTrue();
		expect(existsSync(lockPath)).toBeTrue();
	});

	it("should kill nothing when a Studio that started after the lock file reused its PID", async () => {
		expect.assertions(4);

		const pid = pidOf(spawnFakeStudio());
		const { lockPath, project } = makeLockedProject(pid);
		// The Studio that wrote the lock file an hour ago is gone.
		const anHourAgo = new Date(Date.now() - 3_600_000);
		utimesSync(lockPath, anHourAgo, anHourAgo);
		const { status, stdout } = await runBinAsync(["stop", "--json"], project, NATIVE);

		expect(status).toBe(EXIT_IDENTITY_UNVERIFIED);
		expect(parseResult(stdout).error!.message).toContain("started after the lock file");
		expect(isProcessAlive(pid)).toBeTrue();
		expect(existsSync(lockPath)).toBeTrue();
	});

	it("should report that Studio is not running when the lock names an exited PID", async () => {
		expect.assertions(2);

		const sleeper = spawnSleeper();
		sleeper.kill("SIGKILL");
		await waitForExitAsync(sleeper);
		const { place, project } = makeLockedProject(pidOf(sleeper));
		const { status, stdout } = await runBinAsync(["stop", "--json"], project, NATIVE);

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseResult(stdout).data).toStrictEqual({
			pid: pidOf(sleeper),
			place,
			stopped: false,
		});
	});

	it("should fail with native_missing when the native addon does not load", async () => {
		expect.assertions(2);

		const pid = pidOf(spawnSleeper());
		const { project } = makeLockedProject(pid);
		const { status, stdout } = await runBinAsync(
			["stop", "--json"],
			project,
			nativeEnvironment(makeTemporaryDirectory()),
		);

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout).error!.code).toBe("native_missing");
	});
});
