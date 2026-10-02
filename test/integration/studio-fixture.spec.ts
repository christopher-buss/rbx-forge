import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

async function makeReadyServerAsync(place: string, holdResponse = false) {
	const receivedAt: Array<number> = [];
	const requests: Array<{
		locked: boolean;
		method: string | undefined;
		target: string | undefined;
	}> = [];
	const server = createServer((request, response) => {
		receivedAt.push(Date.now());
		requests.push({
			locked: existsSync(`${place}.lock`),
			method: request.method,
			target: request.url,
		});
		if (!holdResponse) {
			response.writeHead(204).end();
		}
	});
	await new Promise<void>((resolve) => {
		server.listen({ host: "127.0.0.1", port: 0 }, resolve);
	});
	onTestFinished(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
	});
	const address = server.address();
	assert(address !== null && typeof address !== "string");
	const target =
		"/ready/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?projectName=My%20worktree%26place&sessionId=one%20two";
	return { receivedAt, requests, target, url: `http://127.0.0.1:${address.port}${target}` };
}

function startStudioWithReadyUrl(
	place: string,
	url: string,
	variables: Record<string, string> = {},
) {
	const marker = path.join(path.dirname(place), "marker.lua");
	writeFileSync(
		marker,
		`local m=Instance.new("Configuration");m:SetAttribute("ReadyUrl",${JSON.stringify(url)});m.Parent=game\n`,
	);
	return startStudio(
		["--task", "RunScript", "--localPlaceFile", place, "--runScriptFile", marker],
		variables,
	);
}

describe("native Studio fixture", () => {
	it("should acknowledge the exact marker URL after opening the place", async () => {
		expect.assertions(1);

		const place = path.join(makeTemporaryDirectory({ "game.rbxl": "place" }), "game.rbxl");
		const { requests, target, url } = await makeReadyServerAsync(place);
		startStudioWithReadyUrl(place, url);

		await expect
			.poll(() => requests, { timeout: 5000 })
			.toStrictEqual([{ locked: true, method: "GET", target }]);
	});

	it("should keep an opened place alive without acknowledging when configured", async () => {
		expect.assertions(2);

		const place = path.join(makeTemporaryDirectory({ "game.rbxl": "place" }), "game.rbxl");
		const { requests, url } = await makeReadyServerAsync(place);
		const child = startStudioWithReadyUrl(place, url, { FIXTURE_STUDIO_ACK: "none" });
		await waitForFileAsync(`${place}.lock`);
		await sleep(250);
		const pin = loadRealNative().pinProcess(pidOf(child));
		assert(pin !== null);

		expect(requests).toStrictEqual([]);
		expect(pin.isAlive()).toBeTrue();
	});

	it("should send an invalid acknowledgement token when configured", async () => {
		expect.assertions(1);

		const place = path.join(makeTemporaryDirectory({ "game.rbxl": "place" }), "game.rbxl");
		const { requests, url } = await makeReadyServerAsync(place);
		startStudioWithReadyUrl(place, url, { FIXTURE_STUDIO_ACK: "wrong" });

		await expect
			.poll(() => requests[0]!.target, { timeout: 5000 })
			.toStartWith("/ready/wrong-0123456789abcdef");
	});

	it("should delay acknowledgement after the place lock appears", async () => {
		expect.assertions(3);

		const place = path.join(makeTemporaryDirectory({ "game.rbxl": "place" }), "game.rbxl");
		const { receivedAt, requests, url } = await makeReadyServerAsync(place);
		startStudioWithReadyUrl(place, url, { FIXTURE_STUDIO_ACK_DELAY_MS: "1000" });
		await waitForFileAsync(`${place}.lock`);
		const openedAt = statSync(`${place}.lock`).mtimeMs;

		expect(requests).toStrictEqual([]);

		await expect.poll(() => requests, { timeout: 5000 }).toHaveLength(1);

		const [acknowledgedAt] = receivedAt;
		assert(acknowledgedAt !== undefined);

		expect(acknowledgedAt - openedAt).toBeGreaterThanOrEqual(900);
	});

	it("should accept native close while the callback response is stalled", async () => {
		expect.assertions(4);

		const place = path.join(makeTemporaryDirectory({ "game.rbxl": "place" }), "game.rbxl");
		const { requests, url } = await makeReadyServerAsync(place, true);
		const child = startStudioWithReadyUrl(place, url);

		await expect.poll(() => requests, { timeout: 5000 }).toHaveLength(1);

		const pin = loadRealNative().pinProcess(pidOf(child));
		assert(pin !== null);

		expect(pin.requestClose()).toBeTrue();
		expect(pin.waitForExit(500)).toBeTrue();

		await waitForExitAsync(child);

		expect(child.exitCode).toBe(0);
	});

	it("should accept native close before a delayed acknowledgement is sent", async () => {
		expect.assertions(3);

		const place = path.join(makeTemporaryDirectory({ "game.rbxl": "place" }), "game.rbxl");
		const { requests, url } = await makeReadyServerAsync(place);
		const child = startStudioWithReadyUrl(place, url, { FIXTURE_STUDIO_ACK_DELAY_MS: "1000" });
		await waitForFileAsync(`${place}.lock`);
		const pin = loadRealNative().pinProcess(pidOf(child));
		assert(pin !== null);

		expect(pin.requestClose()).toBeTrue();
		expect(pin.waitForExit(500)).toBeTrue();

		await waitForExitAsync(child);
		await sleep(1100);

		expect(requests).toStrictEqual([]);
	});

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
