import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import {
	loadRealNative,
	makeRunScriptStudioExecutable,
	studioVariables,
	waitForFileAsync,
} from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";

async function hiddenStudioAsync(close = "exit") {
	const native = loadRealNative();
	assert(native.spawnDetached !== undefined);
	const executable = makeRunScriptStudioExecutable();
	const directory = makeTemporaryDirectory({ "game.rbxl": "place" });
	const place = path.join(directory, "game.rbxl");
	const pid = native.spawnDetached({
		args: [place],
		cwd: directory,
		desktop: "hidden",
		env: { ...process.env, ...studioVariables(executable), FIXTURE_STUDIO_CLOSE: close },
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

describe.skipIf(process.platform !== "win32")("shared hidden desktop", () => {
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
