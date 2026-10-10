import { type } from "arktype";
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import {
	loadRealNative,
	makeRunScriptStudioExecutable,
	NATIVE_DIRECTORY,
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

async function launchHiddenStudioAsync() {
	const directory = makeTemporaryDirectory({ "game.rbxl": "place", "session.lua": "" });
	const place = path.join(directory, "game.rbxl");
	const trigger = path.join(directory, "new-window");
	const executable = makeRunScriptStudioExecutable();
	const nodeSeams = pathToFileURL(path.resolve("src/seams/node-seams.ts")).href;
	const entry = path.resolve("src/supervisor.ts");
	const source = `import { createNodeSeams } from ${JSON.stringify(nodeSeams)};
const seams = createNodeSeams({ input: process.stdin, output: process.stderr, nativeDirectory: ${JSON.stringify(NATIVE_DIRECTORY)}, noInstalledStudio: true, supervisorEntry: ${JSON.stringify(entry)} });
const outcome = await seams.studioLauncher({ cwd: ${JSON.stringify(directory)}, env: { ...process.env, RBX_FORGE_NATIVE_DIR: ${JSON.stringify(NATIVE_DIRECTORY)}, ...${JSON.stringify(studioVariables(executable))}, FIXTURE_STUDIO_WINDOW_TRIGGER: ${JSON.stringify(trigger)} }, place: ${JSON.stringify(place)}, desktop: 'hidden', runScript: ${JSON.stringify(path.join(directory, "session.lua"))} });
console.log(JSON.stringify(outcome));`;
	const result = await new Promise<string>((resolve, reject) => {
		execFile(
			process.execPath,
			["--input-type=module", "-e", source],
			{ windowsHide: true },
			(error, stdout) => {
				if (error === null) {
					resolve(stdout);
				} else {
					reject(new Error("Studio launcher failed", { cause: error }));
				}
			},
		);
	});
	const outcome = type({ studio: { pid: "number" } }).assert(JSON.parse(result));
	const pinned = loadRealNative().pinProcess(outcome.studio.pid);
	assert(pinned !== null);
	onTestFinished(() => {
		pinned.kill();
		pinned.waitForExit(5000);
	});
	await waitForFileAsync(`${place}.lock`);
	return { pinned, trigger };
}

describe.skipIf(process.platform !== "win32")("windows native window visibility", () => {
	it("keeps new windows hidden after the launching process exits", async () => {
		expect.assertions(7);

		const { pinned, trigger } = await launchHiddenStudioAsync();

		expect(pinned.desktop()).toBe("user");

		writeFileSync(trigger, "new window");
		await waitForFileAsync(`${trigger}.created`);
		await waitForFileAsync(`${trigger}.visible`);

		await expect.poll(() => readFileSync(`${trigger}.visible`, "utf8")).toBe("false");

		await expect.poll(() => pinned.windowVisibility()).toBe("hidden");
		expect(pinned.setWindowVisibility("user")).toBeTrue();
		await expect.poll(() => pinned.windowVisibility()).toBe("user");
		expect(pinned.windowHiding()).toBeFalse();
		await expect.poll(() => readFileSync(`${trigger}.visible`, "utf8")).toBe("true");
	});

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
