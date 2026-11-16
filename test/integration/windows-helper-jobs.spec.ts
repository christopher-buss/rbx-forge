import { type } from "arktype";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { assert, describe, it } from "vitest";

import {
	loadRealNative,
	makeRunScriptStudioExecutable,
	NATIVE_DIRECTORY,
	studioVariables,
	waitForFileAsync,
} from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";

function launchInsideJob(killOnClose: boolean) {
	const place = path.join(makeTemporaryDirectory(), "helper-job.rbxl");
	const program = makeRunScriptStudioExecutable();
	const operations = [
		{ op: "handshake", protocol: 1 },
		{
			args: [place],
			cwd: path.dirname(place),
			desktop: "hidden",
			env: studioVariables(program),
			op: "launch",
			program,
		},
	];
	const output = execFileSync(
		process.execPath,
		[
			path.join(import.meta.dirname, "../fixtures/bin/in-job.ts"),
			path.join(NATIVE_DIRECTORY, `forge-native.win32-${process.arch}-msvc.node`),
			"0",
			path.join(NATIVE_DIRECTORY, "forge-windows-helper.exe"),
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				FIXTURE_JOB_KILL_ON_CLOSE: killOnClose ? "1" : "0",
				FIXTURE_JOB_PIPE_INPUT: "1",
			},
			input: `${operations
				.map((operation, index) => {
					return JSON.stringify({
						...operation,
						id: String(index + 1),
						deadlineMs: Date.now() + 30_000,
					});
				})
				.join("\n")}\n`,
			timeout: 15_000,
			windowsHide: true,
		},
	);
	const replies: Array<unknown> = output
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	return { place, replies };
}

describe.skipIf(process.platform !== "win32")("windows helper launch jobs", () => {
	it("keeps Studio alive after the helper and accounting-job launcher exit", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(3);

		const { place, replies } = launchInsideJob(false);
		const { result } = type({
			id: "'2'",
			result: { pid: "number.integer > 0", pin: "string", startTime: "string" },
		}).assert(replies[1]);
		const native = loadRealNative();
		const pinned = native.pinProcess(result.pid);
		assert(pinned !== null && pinned.startTime === result.startTime);
		onTestFinished(() => {
			pinned.kill();
		});
		await waitForFileAsync(`${place}.lock`);

		expect(replies[0]).toMatchObject({ result: { helperArch: process.arch, protocol: 1 } });
		expect(pinned.isAlive()).toBeTrue();
		expect(native.processStartTime(result.pid)).toBe(result.startTime);
	});

	it("retains the OS denial when the host kills members and forbids breakaway", ({ expect }) => {
		expect.assertions(4);

		const { place, replies } = launchInsideJob(true);
		const { error } = type({
			id: "'2'",
			error: { code: "string", message: "string" },
		}).assert(replies[1]);

		expect(replies[0]).toMatchObject({ result: { helperArch: process.arch, protocol: 1 } });
		expect(error.code).toBe("operation_failed");
		expect(error.message).toMatch(/CreateProcessW with job breakaway:.*os error 5/u);
		expect(existsSync(`${place}.lock`)).toBeFalse();
	});
});
