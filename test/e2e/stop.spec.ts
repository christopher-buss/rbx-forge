import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { EXIT_FAILURE, EXIT_IDENTITY_UNVERIFIED, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import { parseResult } from "../helpers/output.ts";
import {
	NATIVE_DIRECTORY,
	openStudioStandInAsync,
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

/**
 * Make a project whose place a stand-in Studio has open, and a second
 * stand-in Studio with another place open.
 *
 * @param variables - Fixture variables for the first Studio.
 * @returns The project, its place, and both Studios.
 */
async function makeStudioProjectAsync(variables: Record<string, string> = {}): Promise<{
	other: ChildProcess;
	place: string;
	project: string;
	studio: ChildProcess;
}> {
	const project = makeProject({ "rbx-forge.config.json": '{ "projectType": "luau" }' });
	const place = path.join(project, "game.rbxl");
	const studio = await openStudioStandInAsync(place, variables);
	const other = await openStudioStandInAsync(path.join(project, "other.rbxl"));
	return { other, place, project, studio };
}

describe("forge stop", () => {
	it("should close a verified Studio with a close request, and no other Studio", async () => {
		expect.assertions(4);

		const { other, place, project, studio } = await makeStudioProjectAsync();
		const { status, stdout } = await runBinAsync(["stop", "--json"], project, NATIVE);
		await waitForExitAsync(studio);

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseResult(stdout).data).toStrictEqual({
			forced: false,
			pid: pidOf(studio),
			place,
			stopped: true,
		});
		expect(existsSync(`${place}.lock`)).toBeFalse();
		expect({
			isOtherAlive: isProcessAlive(pidOf(other)),
			isOtherOpen: existsSync(path.join(project, "other.rbxl.lock")),
		}).toStrictEqual({ isOtherAlive: true, isOtherOpen: true });
	});

	it("should end a Studio that stays open after the close request, and remove its lock file", async () => {
		expect.assertions(3);

		const { place, project, studio } = await makeStudioProjectAsync({
			FIXTURE_STUDIO_REFUSE_CLOSE: "1",
		});
		const { status, stdout } = await runBinAsync(["stop", "--json"], project, NATIVE);
		await waitForExitAsync(studio);

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseResult(stdout).data).toStrictEqual({
			forced: true,
			pid: pidOf(studio),
			place,
			stopped: true,
		});
		expect(existsSync(`${place}.lock`)).toBeFalse();
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
