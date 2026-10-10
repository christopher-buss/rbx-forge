import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import {
	loadRealNative,
	makeRunScriptStudioExecutable,
	pidOf,
	studioVariables,
	waitForExitAsync,
	waitForFileAsync,
} from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";

async function windowStudioAsync() {
	const directory = makeTemporaryDirectory({ "game.rbxl": "place" });
	const place = path.join(directory, "game.rbxl");
	const trigger = path.join(directory, "new-window");
	const executable = makeRunScriptStudioExecutable();
	const child = spawn(executable, [place], {
		env: {
			...process.env,
			...studioVariables(executable),
			FIXTURE_STUDIO_WINDOW_TRIGGER: trigger,
		},
		stdio: "ignore",
		windowsHide: true,
	});
	onTestFinished(async () => {
		child.kill("SIGKILL");
		await waitForExitAsync(child);
	});
	await waitForFileAsync(`${place}.lock`);
	const pinned = loadRealNative().pinProcess(pidOf(child));
	assert(pinned !== null);
	return { child, pinned, trigger };
}

describe.skipIf(process.platform !== "win32")("windows native window visibility", () => {
	it("hides every window, re-hides new windows, and stops watching when shown", async () => {
		expect.assertions(5);

		const { pinned, trigger } = await windowStudioAsync();

		expect({
			desktop: pinned.desktop(),
			hidden: pinned.setWindowVisibility("hidden"),
			watching: pinned.startWindowHiding(),
		}).toStrictEqual({ desktop: "user", hidden: true, watching: true });

		writeFileSync(trigger, "new window");

		await expect.poll(() => pinned.windowVisibility()).toBe("hidden");
		expect({
			shown: pinned.setWindowVisibility("user"),
			watching: pinned.stopWindowHiding(),
		}).toStrictEqual({ shown: true, watching: false });
		await expect.poll(() => pinned.windowVisibility()).toBe("user");
		expect({
			active: pinned.setWindowVisibility("active"),
			visibility: pinned.windowVisibility(),
		}).toStrictEqual({ active: true, visibility: "user" });
	});

	it("ends its watcher and refuses window operations after the pinned process exits", async () => {
		expect.assertions(2);

		const { child, pinned } = await windowStudioAsync();

		expect(pinned.startWindowHiding()).toBeTrue();

		child.kill("SIGKILL");
		await waitForExitAsync(child);

		expect({
			active: pinned.setWindowVisibility("active"),
			alive: pinned.isAlive(),
			started: pinned.startWindowHiding(),
			stopped: pinned.stopWindowHiding(),
			visibility: pinned.windowVisibility(),
		}).toStrictEqual({
			active: false,
			alive: false,
			started: false,
			stopped: false,
			visibility: null,
		});
	});
});
