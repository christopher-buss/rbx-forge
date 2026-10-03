import os from "node:os";
import path from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { catchForgeError } from "../../test/helpers/errors.ts";
import { REAPER_PATH } from "../../test/helpers/real-native.ts";
import { makeTemporaryDirectory } from "../../test/helpers/temporary-directory.ts";
import { nodeNetwork } from "./network.ts";
import { createNodeSeams } from "./node-seams.ts";

/** POSIX: this process's user id; Windows has none. */
const USER_ID = process.getuid?.();

function makeSeams(nativeDirectory?: string): ReturnType<typeof createNodeSeams> {
	return createNodeSeams({
		input: new PassThrough(),
		nativeDirectory,
		output: new PassThrough(),
		supervisorEntry: "/forge/supervisor.mjs",
	});
}

describe(createNodeSeams, () => {
	it("should read and write the real disk", () => {
		expect.assertions(1);

		const directory = makeTemporaryDirectory();
		const { fileSystem } = makeSeams();
		const file = path.join(directory, "note.txt");
		fileSystem.writeFileSync(file, "hello");

		expect(fileSystem.readFileSync(file, "utf8")).toBe("hello");
	});

	it("should load config files with the c12 loader", async () => {
		expect.assertions(1);

		const directory = makeTemporaryDirectory({
			"rbx-forge.config.json": '{ "projectType": "luau" }',
		});

		await expect(makeSeams().configLoader(directory)).resolves.toMatchObject({
			value: { projectType: "luau" },
		});
	});

	it("should spawn through node:child_process", () => {
		expect.assertions(1);

		// Only the function identity: unit tests never start a process.
		expect(makeSeams().childProcess.spawn.name).toBe("spawn");
	});

	it("should describe this Node process and OS", () => {
		expect.assertions(1);

		expect(makeSeams().host).toMatchObject({
			execPath: process.execPath,
			hostname: os.hostname(),
			platform: process.platform,
		});
	});

	it("should report when the OS booted", () => {
		expect.assertions(2);

		const bootTimeMs = makeSeams().host.bootTimeMs();

		expect(bootTimeMs).toBeLessThan(Date.now());
		expect(Math.abs(bootTimeMs - (Date.now() - os.uptime() * 1000))).toBeLessThan(1000);
	});

	it("should name this process and its user", () => {
		expect.assertions(2);

		const { host } = makeSeams();

		expect(host.pid).toBe(process.pid);
		expect(host.userId).toBe(USER_ID);
	});

	it("should signal processes through process.kill", () => {
		expect.assertions(1);

		// No process has this pid, so the real call fails without a target.
		expect(() => {
			makeSeams().host.kill(2 ** 30, "SIGTERM");
		}).toThrow(expect.objectContaining({ code: "ESRCH" }));
	});

	it("should load the native addon for this host from the given directory", () => {
		expect.assertions(2);

		// An empty directory: the loader looks there and finds no build.
		const directory = makeTemporaryDirectory();
		const error = catchForgeError(makeSeams(directory).native);

		expect(error.code).toBe("native_missing");
		expect(error.message).toStartWith(
			`Could not load ${path.join(directory, "forge-native.")}`,
		);
	});

	it("should look for the reaper next to the addon in the given directory", async () => {
		expect.assertions(1);

		const directory = makeTemporaryDirectory();
		const binary = path.join(directory, path.basename(REAPER_PATH));
		const launch = makeSeams(directory).reaper({
			leasePath: "l",
			recordPath: "r",
			sessionId: "s",
		});

		await expect(launch).rejects.toMatchObject({
			code: "reaper_unavailable",
			message: `${binary} is missing or cannot run.`,
		});
	});

	it("should look for the reaper in the platform package without a directory", async () => {
		expect.assertions(2);

		// No platform package is installed in this repository.
		const launch = makeSeams().reaper({ leasePath: "l", recordPath: "r", sessionId: "s" });

		await expect(launch).rejects.toMatchObject({ code: "reaper_unavailable" });
		await expect(launch).rejects.toThrow(/^Could not find @rbx-forge\/native-/);
	});

	it("should make random session ids", () => {
		expect.assertions(2);

		const { randomId } = makeSeams();

		expect(randomId()).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/);
		expect(randomId()).not.toBe(randomId());
	});

	it("should probe ports and listen for signals on this process", () => {
		expect.assertions(2);

		const { network, signals } = makeSeams();
		const before = process.listenerCount("SIGINT");
		const remove = signals.onStop(() => {
			// Never called: the listener is removed at once.
		});
		const during = process.listenerCount("SIGINT");
		remove();

		expect(network).toBe(nodeNetwork);
		expect([during - before, process.listenerCount("SIGINT")]).toStrictEqual([1, before]);
	});

	it("should tell the time", () => {
		expect.assertions(1);

		expect(makeSeams().clock.now()).toBeGreaterThan(0);
	});

	it("should prompt on the given streams", async () => {
		expect.assertions(1);

		const input = new PassThrough();
		const { prompter } = createNodeSeams({
			input,
			nativeDirectory: undefined,
			output: new PassThrough(),
			supervisorEntry: "/forge/supervisor.mjs",
		});
		const answer = prompter.confirm("Go?", false);
		setImmediate(() => {
			input.write("y\n");
		});

		await expect(answer).resolves.toBeTrue();
	});
});
