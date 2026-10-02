import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import { withVariables } from "../../src/process/environment.ts";
import {
	loadRealNative,
	makeRunScriptStudioExecutable,
	pidOf,
	studioVariables,
	waitForExitAsync,
	waitForFileAsync,
} from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";
import { readWorkerLog } from "../helpers/worker-log.ts";

const AUTO_SAVE_FOLDERS =
	process.platform === "win32"
		? ["Roblox", "RobloxStudio", "AutoSaves"]
		: ["Library", "Application Support", "Roblox", "RobloxStudio", "AutoSaves"];

function startStudio(args: Array<string>, variables: Record<string, string> = {}) {
	const executable = makeRunScriptStudioExecutable();
	const child = spawn(executable, args, {
		env: withVariables(
			process.env,
			{ ...studioVariables(executable), ...variables },
			process.platform,
		),
		stdio: "ignore",
		windowsHide: true,
	});
	onTestFinished(async () => {
		child.kill("SIGKILL");
		await waitForExitAsync(child);
	});
	return child;
}

describe("native Studio fixture", () => {
	it("should open the RunScript place under its own pinned identity and close it", async () => {
		expect.assertions(5);

		const directory = makeTemporaryDirectory({
			"game.rbxl": "place",
			"marker.luau": "-- marker",
		});
		const place = path.join(directory, "game.rbxl");
		const log = path.join(directory, "workers.ndjson");
		const args = [
			"--task",
			"RunScript",
			"--localPlaceFile",
			place,
			"--runScriptFile",
			path.join(directory, "marker.luau"),
		];
		const child = startStudio(args, { FIXTURE_LOG: log });
		await waitForFileAsync(`${place}.lock`);
		const pin = loadRealNative().pinProcess(pidOf(child));
		assert(pin !== null);

		expect(readWorkerLog(log)).toMatchObject([
			{ args, pid: pidOf(child), ppid: process.pid, role: "studio" },
		]);
		expect(readFileSync(`${place}.lock`, "utf8")).toBe(
			`${pidOf(child)}\nRobloxStudioBeta\n${os.hostname()}\n00000000-0000-0000-0000-000000000000\n`,
		);
		expect(pin.requestClose()).toBeTrue();

		await waitForExitAsync(child);

		expect(child.exitCode).toBe(0);
		expect(existsSync(`${place}.lock`)).toBeFalse();
	});

	it("should delay the place lock while Studio opens it", async () => {
		expect.assertions(2);

		const directory = makeTemporaryDirectory({ "game.rbxl": "place" });
		const place = path.join(directory, "game.rbxl");
		const log = path.join(directory, "workers.ndjson");
		startStudio([place], { FIXTURE_LOG: log, FIXTURE_STUDIO_LOCK_DELAY_MS: "300" });
		await waitForFileAsync(log);

		expect(existsSync(`${place}.lock`)).toBeFalse();

		await waitForFileAsync(`${place}.lock`);
		const [record] = readWorkerLog(log);
		assert(record !== undefined);

		expect(Date.now() - record.at).toBeGreaterThanOrEqual(300);
	});

	it("should write Studio auto-recovery into the scratch home", async () => {
		expect.assertions(1);

		const directory = makeTemporaryDirectory({ "game.rbxl": "place" });
		const place = path.join(directory, "game.rbxl");
		startStudio([place], {
			FIXTURE_STUDIO_AUTOSAVE: "1",
			HOME: directory,
			LOCALAPPDATA: directory,
		});
		await waitForFileAsync(`${place}.lock`);
		const autoSave = path.join(directory, ...AUTO_SAVE_FOLDERS, "game_AutoRecovery_0.rbxl");

		expect(readFileSync(autoSave, "utf8")).toBe("auto-recovery\n");
	});

	it.for([
		{ blocked: process.platform === "win32", close: "dialog", locked: true },
		{ blocked: false, close: "refuse", locked: true },
		{ blocked: false, close: "linger", locked: false },
	])(
		"should preserve $close behavior for native close requests",
		async ({ blocked, close, locked }) => {
			expect.assertions(4);

			const place = path.join(makeTemporaryDirectory({ "game.rbxl": "place" }), "game.rbxl");
			const child = startStudio([place], { FIXTURE_STUDIO_CLOSE: close });
			await waitForFileAsync(`${place}.lock`);
			const pin = loadRealNative().pinProcess(pidOf(child));
			assert(pin !== null);

			expect(pin.requestClose()).toBeTrue();

			await sleep(200);

			expect(pin.isAlive()).toBeTrue();
			expect(pin.isBlocked()).toBe(blocked);
			expect(existsSync(`${place}.lock`)).toBe(locked);
		},
	);
});
