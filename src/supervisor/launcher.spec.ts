import { describe, expect, it, vi } from "vitest";

import { createFakeSpawner } from "../../test/helpers/fake-process.ts";
import type { FakeChild } from "../../test/helpers/fake-process.ts";
import type { ReporterEvent } from "../seams/reporter.ts";
import { encodeMessage } from "./channel.ts";
import type { SupervisorRun } from "./launcher.ts";
import { createSupervisorLauncher } from "./launcher.ts";

const REQUEST = { compiler: true, config: {}, open: false, rojo: true };

function launch() {
	const spawner = createFakeSpawner();
	const onEvent = vi.fn<(event: ReporterEvent) => void>();
	const run: SupervisorRun = createSupervisorLauncher(
		{ childProcess: spawner.runner, host: { execPath: "/node" } },
		"/forge/dist/supervisor.mjs",
	)({ cwd: "/project", env: { PATH: "/bin" }, onEvent, request: REQUEST });
	const child: FakeChild = spawner.children[0]!;
	let written = "";
	child.stdin.setEncoding("utf8");
	child.stdin.on("data", (chunk: string) => {
		written += chunk;
	});
	return { call: spawner.calls[0]!, child, onEvent, run, written: () => written };
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

describe(createSupervisorLauncher, () => {
	it("should run the entry detached with Node, the request, and piped streams", () => {
		expect.assertions(1);

		const { call } = launch();

		expect(call).toStrictEqual({
			args: ["/forge/dist/supervisor.mjs", JSON.stringify(REQUEST)],
			file: "/node",
			options: {
				cwd: "/project",
				detached: true,
				env: { PATH: "/bin" },
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			},
		});
	});

	it("should relay events and resolve with the result once the supervisor exits", async () => {
		expect.assertions(2);

		const { child, onEvent, run } = launch();
		child.stdout.write(
			encodeMessage({ event: { message: "hi", type: "info" }, type: "event" }),
		);
		child.stdout.write(
			encodeMessage({ data: { a: 1 }, ok: true, summary: "done", type: "result" }),
		);
		child.stdout.write("not a message\n");
		await flushAsync();
		child.close(0);

		await expect(run.result).resolves.toStrictEqual({ data: { a: 1 }, summary: "done" });
		expect(onEvent).toHaveBeenCalledExactlyOnceWith({ message: "hi", type: "info" });
	});

	it("should resolve at once once the supervisor let this start go, and ignore its later exit", async () => {
		expect.assertions(1);

		const { child, run } = launch();
		child.stdout.write(
			encodeMessage({ data: { stopped: ["rojo"] }, summary: "Let go.", type: "released" }),
		);
		const result = await run.result;
		child.close(1);
		await flushAsync();

		expect(result).toStrictEqual({ data: { stopped: ["rojo"] }, summary: "Let go." });
	});

	it("should reject with the session's failure", async () => {
		expect.assertions(1);

		const { child, run } = launch();
		child.stdout.write(
			encodeMessage({
				error: { code: "session_running", hint: "stop it", message: "running" },
				ok: false,
				type: "result",
			}),
		);
		await flushAsync();
		child.close(1);

		await expect(run.result).rejects.toMatchObject({
			code: "session_running",
			hint: "stop it",
			message: "running",
		});
	});

	it("should reject with internal_error and its stderr when it exits without a result", async () => {
		expect.assertions(2);

		const exited = launch();
		exited.child.stderr.write("Error: boom\n");
		await flushAsync();
		exited.child.close(1);
		const killed = launch();
		killed.child.close(null, "SIGKILL");

		await expect(exited.run.result).rejects.toMatchObject({
			code: "internal_error",
			hint: "This is a bug in forge. Please report it.",
			message: "The supervisor exited (exit code 1) without a result.\nError: boom",
		});
		await expect(killed.run.result).rejects.toMatchObject({
			message: "The supervisor exited (signal SIGKILL) without a result.",
		});
	});

	it("should reject with internal_error when the supervisor does not start", async () => {
		expect.assertions(1);

		const { child, run } = launch();
		child.error(new Error("spawn /node EACCES"));

		await expect(run.result).rejects.toMatchObject({
			code: "internal_error",
			message: "The supervisor did not start: spawn /node EACCES",
		});
	});

	it("should pass a stop signal on through the owner pipe, even after the pipe broke", async () => {
		expect.assertions(1);

		const { child, run, written } = launch();
		run.stop("SIGINT");
		await flushAsync();
		child.stdin.emit("error", new Error("EPIPE"));

		expect(written()).toBe('{"signal":"SIGINT","type":"stop"}\n');
	});
});
