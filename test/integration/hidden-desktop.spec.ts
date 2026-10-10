import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import { studioProcess } from "../../src/studio/launcher.ts";
import {
	loadRealNative,
	makeRunScriptStudioExecutable,
	realNativePath,
	studioVariables,
	waitForFileAsync,
} from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";
import { waitForDeathAsync } from "../helpers/worker-log.ts";

async function hiddenStudioAsync(
	close = "exit",
	variables: Record<string, string> = {},
	desktop: "hidden" | "user" = "hidden",
	hiddenWindows = false,
) {
	const native = loadRealNative();
	assert(native.spawnDetached !== undefined);
	const executable = makeRunScriptStudioExecutable();
	const directory = makeTemporaryDirectory({ "game.rbxl": "place" });
	const place = path.join(directory, "game.rbxl");
	const pid = native.spawnDetached({
		args: [place],
		cwd: directory,
		desktop,
		env: {
			...process.env,
			...studioVariables(executable),
			FIXTURE_STUDIO_CLOSE: close,
			...variables,
		},
		hiddenWindows,
		program: executable,
	});
	assert(pid !== null);
	const pin = native.pinProcess(pid);
	assert(pin !== null);
	onTestFinished(() => {
		pin.kill();
		pin.waitForExit(5000);
	});
	await waitForFileAsync(`${place}.lock`);
	return { pin, place };
}

async function queryHiddenClientAsync(pid: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			[
				"-e",
				"const addon = require(process.argv[1]); const pin = addon.pinProcess(Number(process.argv[2])); const desktop = pin.desktop(); console.log(JSON.stringify({blocked: pin.isBlocked(), closed: pin.requestClose(), desktop}));",
				realNativePath(),
				String(pid),
			],
			{ timeout: 10_000, windowsHide: true },
			(error, stdout) => {
				if (error === null) {
					resolve(stdout);
				} else {
					reject(new Error("Cold native client failed.", { cause: error }));
				}
			},
		);
	});
}

async function launchSnapshotWatcherAsync(
	studio: { pid: number; startTime: string },
	place: string,
): Promise<number> {
	const launcher = path.join(
		import.meta.dirname,
		"..",
		"..",
		"src",
		"studio",
		"snapshot-lighting-launcher.ts",
	);
	const entry = path.join(import.meta.dirname, "..", "..", "src", "supervisor.ts");
	const source = `import { createSnapshotLightingLauncher } from ${JSON.stringify(pathToFileURL(launcher).href)};
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const launch = createSnapshotLightingLauncher({ host: { execPath: process.execPath }, native: () => require(${JSON.stringify(realNativePath())}) }, ${JSON.stringify(entry)});
console.log(launch({ cwd: ${JSON.stringify(path.dirname(place))}, env: { ...process.env, RBX_FORGE_NATIVE_DIR: ${JSON.stringify(path.dirname(realNativePath()))} }, place: ${JSON.stringify(place)}, studio: ${JSON.stringify(studio)} }));`;
	const pid = await new Promise<number>((resolve, reject) => {
		execFile(
			process.execPath,
			["--input-type=module", "-e", source],
			{ windowsHide: true },
			(error, stdout) => {
				if (error !== null) {
					reject(new Error("The snapshot launching client failed.", { cause: error }));
				} else {
					resolve(Number(stdout.trim()));
				}
			},
		);
	});
	const pinned = loadRealNative().pinProcess(pid);
	assert(pinned !== null);
	onTestFinished(() => {
		pinned.kill();
		pinned.waitForExit(5000);
	});
	return pid;
}

describe.skipIf(process.platform !== "win32")("shared hidden desktop", () => {
	it("launches a hidden session on the user desktop and preserves its visibility", async () => {
		expect.assertions(2);

		const { pin } = await hiddenStudioAsync("exit", {}, "user", true);

		expect({ desktop: pin.desktop(), visibility: pin.windowVisibility() }).toStrictEqual({
			desktop: "user",
			visibility: "hidden",
		});
		expect(studioProcess(pin)).toMatchObject({ desktop: "hidden" });
	});

	it("keeps snapshots on the hidden desktop when their windows are shown there", async () => {
		expect.assertions(2);

		const { pin } = await hiddenStudioAsync();
		assert(pin.setWindowVisibility("user"));

		await expect.poll(() => pin.windowVisibility()).toBe("user");
		expect(studioProcess(pin)).toMatchObject({ desktop: "hidden" });
	});

	it(
		"dismisses a delayed snapshot prompt after the launching client exits",
		{ timeout: 20_000 },
		async () => {
			expect.assertions(5);

			const { pin, place } = await hiddenStudioAsync("exit", {
				FIXTURE_STUDIO_DIALOG_DELAY_MS: "7000",
			});
			const watcherPid = await launchSnapshotWatcherAsync(
				{ pid: pin.pid, startTime: pin.startTime },
				place,
			);
			const watcher = loadRealNative().pinProcess(watcherPid);
			assert(watcher !== null);

			expect(watcher.isAlive()).toBeTrue();

			await sleep(8500);

			expect(watcher.waitForExit(5000)).toBeTrue();

			await expect(waitForDeathAsync([watcherPid], 5000)).resolves.toStrictEqual([]);

			expect(pin.isBlocked()).toBeFalse();
			expect(pin.isAlive()).toBeTrue();
		},
	);

	it("ends the independent snapshot watcher when Studio exits", async () => {
		expect.assertions(4);

		const { pin, place } = await hiddenStudioAsync();
		const watcherPid = await launchSnapshotWatcherAsync(
			{ pid: pin.pid, startTime: pin.startTime },
			place,
		);
		const watcher = loadRealNative().pinProcess(watcherPid);
		assert(watcher !== null);

		expect(watcher.isAlive()).toBeTrue();

		pin.kill();

		expect(watcher.waitForExit(5000)).toBeTrue();

		await expect(waitForDeathAsync([watcherPid], 5000)).resolves.toStrictEqual([]);

		expect(watcher.isAlive()).toBeFalse();
	});

	it("queries and closes hidden Studio from a client that never launched it", async () => {
		expect.assertions(2);

		const { pin, place } = await hiddenStudioAsync();
		const stdout = await queryHiddenClientAsync(pin.pid);

		expect(stdout.trim()).toBe('{"blocked":false,"closed":true,"desktop":"hidden"}');

		await sleep(300);

		expect(existsSync(`${place}.lock`)).toBeFalse();
	});

	it("dismisses only the exact migration dialog of the pinned hidden Studio", async () => {
		expect.assertions(4);

		const variables = { FIXTURE_STUDIO_DIALOG_DELAY_MS: "0" };
		const first = await hiddenStudioAsync("exit", variables);
		const second = await hiddenStudioAsync("exit", variables);
		await sleep(300);

		expect([first.pin.isBlocked(), second.pin.isBlocked()]).toStrictEqual([true, true]);
		await expect(
			Promise.all([
				first.pin.dismissDialog("Other dialog", "Continue", "hidden", 5000),
				first.pin.dismissDialog(
					"Lighting Technology Migration",
					"Other button",
					"hidden",
					5000,
				),
				first.pin.dismissDialog("Lighting Technology Migration", "Continue", "user", 5000),
			]),
		).resolves.toStrictEqual([false, false, false]);
		await expect(
			first.pin.dismissDialog("Lighting Technology Migration", "Continue", "hidden", 5000),
		).resolves.toBeTrue();

		await sleep(300);

		expect([first.pin.isBlocked(), second.pin.isBlocked()]).toStrictEqual([false, true]);
	});

	it("makes concurrent and expired dismissal requests harmless", async () => {
		expect.assertions(4);

		const { pin } = await hiddenStudioAsync("exit", { FIXTURE_STUDIO_DIALOG_DELAY_MS: "0" });
		await sleep(300);

		await expect(
			pin.dismissDialog("Lighting Technology Migration", "Continue", "hidden", 0),
		).resolves.toBeFalse();
		await expect(
			Promise.all([
				pin.dismissDialog("Lighting Technology Migration", "Continue", "hidden", 5000),
				pin.dismissDialog("Lighting Technology Migration", "Continue", "hidden", 5000),
			]),
		).resolves.toStrictEqual(expect.arrayContaining([true]));

		await sleep(300);

		expect(pin.isBlocked()).toBeFalse();
		await expect(
			pin.dismissDialog("Lighting Technology Migration", "Continue", "hidden", 5000),
		).resolves.toBeFalse();
	});

	it.for(["hidden", "user"] as const)(
		"reports a missing save menu on the %s desktop",
		async (desktop) => {
			expect.assertions(1);

			const { pin } = await hiddenStudioAsync("exit", {}, desktop);

			await expect(pin.requestSave(5000)).resolves.toBe("no_menu_item");
		},
	);

	it("should open one desktop for successive detached Studios and close their windows", async () => {
		expect.assertions(4);

		const first = await hiddenStudioAsync();
		const second = await hiddenStudioAsync();

		expect([first.pin.desktop(), second.pin.desktop()]).toStrictEqual(["hidden", "hidden"]);
		expect(first.pin.requestClose()).toBeTrue();
		expect(second.pin.requestClose()).toBeTrue();

		await sleep(300);

		expect([
			existsSync(`${first.place}.lock`),
			existsSync(`${second.place}.lock`),
		]).toStrictEqual([false, false]);
	});

	it("should detect a modal on the hidden desktop after a close request", async () => {
		expect.assertions(3);

		const { pin } = await hiddenStudioAsync("dialog");

		expect(pin.isBlocked()).toBeFalse();
		expect(pin.requestClose()).toBeTrue();

		await sleep(300);

		expect(pin.isBlocked()).toBeTrue();
	});
});
