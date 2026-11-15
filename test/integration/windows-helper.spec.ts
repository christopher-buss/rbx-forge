import { type } from "arktype";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import type { TestContext } from "vitest";
import { assert, describe, it } from "vitest";

import { createHelperClient } from "../../src/native/helper-client.ts";
import { nodeChildProcessRunner } from "../../src/seams/child-process.ts";
import { nodeClock } from "../../src/seams/clock.ts";
import { nodeNetwork } from "../../src/seams/network.ts";
import {
	loadRealNative,
	makeRunScriptStudioExecutable,
	NATIVE_DIRECTORY,
	studioVariables,
	waitForExitAsync,
	waitForFileAsync,
} from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";

function startHelper({ onTestFinished }: Pick<TestContext, "onTestFinished">) {
	const child = spawn(path.join(NATIVE_DIRECTORY, "forge-windows-helper.exe"), [], {
		stdio: "pipe",
		windowsHide: true,
	});
	const lines = createInterface({ input: child.stdout });
	const iterator = lines[Symbol.asyncIterator]();
	onTestFinished(async () => {
		child.kill();
		lines.close();
		await waitForExitAsync(child);
	});
	let serial = 0;
	async function requestAsync(operation: Record<string, unknown>) {
		serial += 1;
		const id = String(serial);
		child.stdin.write(
			`${JSON.stringify({ id, deadlineMs: Date.now() + 10_000, ...operation })}\n`,
		);
		const line = await iterator.next();
		assert(line.done !== true);
		const reply: unknown = JSON.parse(line.value);
		assert(typeof reply === "object" && reply !== null && "id" in reply && reply.id === id);
		return reply;
	}

	return { child, requestAsync };
}

async function launchStudioAsync(testContext: Pick<TestContext, "onTestFinished">) {
	const helper = startHelper(testContext);
	await helper.requestAsync({ op: "handshake", protocol: 1 });
	const native = loadRealNative();
	const program = makeRunScriptStudioExecutable();
	const place = path.join(makeTemporaryDirectory(), "helper.rbxl");
	const reply = await helper.requestAsync({
		args: [place],
		cwd: path.dirname(place),
		env: studioVariables(program),
		op: "launch",
		program,
	});
	assert("result" in reply);
	const { result } = reply;
	assert(
		typeof result === "object" &&
			result !== null &&
			"pid" in result &&
			"pin" in result &&
			"startTime" in result,
	);
	assert(typeof result.pid === "number");
	const pinned = native.pinProcess(result.pid);
	assert(pinned !== null);
	testContext.onTestFinished(() => {
		pinned.kill();
	});
	await waitForFileAsync(`${place}.lock`);
	return { ...helper, pinned, program, result };
}

describe.skipIf(process.platform !== "win32")("windows helper", () => {
	it("probes capture without acknowledging Studio synchronization", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(2);

		const identity = { projectName: "probe", sessionId: "generation" };
		const capture = await nodeNetwork.listenForCaptureAsync(identity);
		const ready = await nodeNetwork.listenForStudioReadyAsync(identity);
		onTestFinished(() => {
			capture.close();
			ready.close();
		});
		const url = new URL(capture.url);
		const { requestAsync } = startHelper({ onTestFinished });
		await requestAsync({ op: "handshake", protocol: 1 });

		expect(
			await requestAsync({
				op: "probeHttp",
				port: Number(url.port),
				route: `${url.pathname}/probe/nonce${url.search}`,
			}),
		).toMatchObject({ result: [110, 111, 110, 99, 101] });

		ready.close();

		await expect(ready.ready).resolves.toBe(false);
	});

	it("probes HTTP from Windows IPv4 loopback and reports failures", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(4);

		let status = 200;
		const server = createServer((_request, response) => {
			response.writeHead(status, { "content-length": 5 }).end("nonce");
		});
		onTestFinished(() => {
			server.close();
			server.closeAllConnections();
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		assert(address !== null && typeof address === "object");
		const { port } = address;
		const { requestAsync } = startHelper({ onTestFinished });
		await requestAsync({ op: "handshake", protocol: 1 });

		expect(await requestAsync({ op: "probeHttp", port, route: "/api/rojo" })).toMatchObject({
			result: [110, 111, 110, 99, 101],
		});

		status = 404;

		expect(
			await requestAsync({ op: "probeHttp", port, route: "/capture/secret/probe/nonce" }),
		).toMatchObject({ error: { code: "operation_failed" } });
		expect(await requestAsync({ op: "probeHttp", port, route: "/ready/secret" })).toMatchObject(
			{ error: { code: "operation_failed" } },
		);

		server.close();
		server.closeAllConnections();

		expect(await requestAsync({ op: "probeHttp", port, route: "/api/rojo" })).toMatchObject({
			error: { code: "operation_failed" },
		});
	});

	it("reads a Windows registry command through the helper", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(2);

		const key = `Software\\rbx-forge-test\\${randomUUID()}`;
		const fullKey = `HKCU\\${key}`;
		const command = `"${path.join(makeTemporaryDirectory(), "Studio with spaces.exe")}" "%1"`;
		execFileSync("reg.exe", ["add", fullKey, "/ve", "/t", "REG_SZ", "/d", command, "/f"], {
			windowsHide: true,
		});
		onTestFinished(() => {
			execFileSync("reg.exe", ["delete", fullKey, "/f"], { windowsHide: true });
		});
		const { requestAsync } = startHelper({ onTestFinished });
		await requestAsync({ op: "handshake", protocol: 1 });

		await expect(requestAsync({ key, op: "readRegistry" })).resolves.toHaveProperty(
			"result",
			command,
		);
		await expect(
			requestAsync({ key: `${key}\\missing`, op: "readRegistry" }),
		).resolves.toHaveProperty("result", null);
	});

	it("uses the TypeScript client against the real helper protocol", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(5);

		const client = createHelperClient(
			{ childProcess: nodeChildProcessRunner, clock: nodeClock },
			() => ({ args: [], file: path.join(NATIVE_DIRECTORY, "forge-windows-helper.exe") }),
			process.arch,
		);

		const identity = await client.identity;

		expect(identity.hostname.toLowerCase()).toBe(os.hostname().toLowerCase());

		const program = makeRunScriptStudioExecutable();
		const place = path.join(makeTemporaryDirectory(), "client.rbxl");
		const result = type({ pid: "number", pin: "string", startTime: "string" }).assert(
			await client.requestAsync({
				args: [place],
				cwd: path.dirname(place),
				env: studioVariables(program),
				op: "launch",
				program,
			}),
		);
		const pinned = loadRealNative().pinProcess(result.pid);
		assert(pinned !== null);
		onTestFinished(() => {
			pinned.kill();
		});
		await waitForFileAsync(`${place}.lock`);

		await expect(
			client.requestAsync({ op: "processStartTime", pid: result.pid }),
		).resolves.toBe(result.startTime);
		await expect(
			client.requestAsync({ key: "Software\\rbx-forge-test-missing", op: "readRegistry" }),
		).resolves.toBeNull();
		await expect(client.requestAsync({ op: "requestClose", pin: result.pin })).resolves.toBe(
			true,
		);
		await expect.poll(() => pinned.isAlive()).toBeFalse();
	});

	it("should report a versioned Windows identity", async ({ expect, onTestFinished }) => {
		expect.assertions(2);

		const { requestAsync } = startHelper({ onTestFinished });
		const reply = await requestAsync({ op: "handshake", protocol: 1 });

		expect(reply).toMatchObject({
			result: { helperArch: process.arch, protocol: 1, windowsArch: process.arch },
		});

		assert(
			"result" in reply &&
				typeof reply.result === "object" &&
				reply.result !== null &&
				"hostname" in reply.result &&
				typeof reply.result.hostname === "string",
		);

		expect(reply.result.hostname.toLowerCase()).toBe(os.hostname().toLowerCase());
	});

	it("should launch, re-pin by Windows identity, refuse a reused identity and close", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(5);

		const { pinned, program, requestAsync, result } = await launchStudioAsync({
			onTestFinished,
		});

		await expect(
			requestAsync({ op: "pin", pid: result.pid, startTime: result.startTime }),
		).resolves.toHaveProperty("result.pid", result.pid);
		await expect(
			requestAsync({ op: "pin", pid: result.pid, startTime: "1" }),
		).resolves.toHaveProperty("error.message", "process identity mismatch");
		await expect(
			requestAsync({ op: "executablePath", pin: result.pin }),
		).resolves.toHaveProperty("result", program);
		await expect(requestAsync({ op: "requestClose", pin: result.pin })).resolves.toHaveProperty(
			"result",
			true,
		);
		await expect.poll(() => pinned.isAlive()).toBeFalse();
	});

	it("should kill only the pinned Studio", async ({ expect, onTestFinished }) => {
		expect.assertions(3);

		const { pinned, requestAsync, result } = await launchStudioAsync({ onTestFinished });

		await expect(requestAsync({ op: "isAlive", pin: result.pin })).resolves.toHaveProperty(
			"result",
			true,
		);
		await expect(requestAsync({ op: "kill", pin: result.pin })).resolves.toHaveProperty(
			"result",
			true,
		);
		await expect.poll(() => pinned.isAlive()).toBeFalse();
	});

	it("should leave Studio running after stdin EOF", async ({ expect, onTestFinished }) => {
		expect.assertions(2);

		const { child, pinned } = await launchStudioAsync({ onTestFinished });
		child.stdin.end();
		await waitForExitAsync(child);

		expect(child.exitCode).toBe(0);
		expect(pinned.isAlive()).toBeTrue();
	});
});
