import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import {
	loadRealNative,
	makeRunScriptStudioExecutable,
	realNativePath,
	studioVariables,
	waitForFileAsync,
} from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";

async function hiddenStudioAsync(
	close = "exit",
	variables: Record<string, string> = {},
	desktop: "hidden" | "user" = "hidden",
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

describe.skipIf(process.platform !== "win32")("shared hidden desktop", () => {
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
