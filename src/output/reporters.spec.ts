import { describe, expect, it } from "vitest";

import { captureOutput } from "../../test/helpers/output.ts";
import { EXIT_NEEDS_CONFIRMATION } from "../exit-codes.ts";
import type { CommandFailure } from "../seams/reporter.ts";
import { createJsonReporter, createReporter, createTtyReporter } from "./reporters.ts";

const FAILURE: CommandFailure = {
	code: "needs_confirmation",
	command: "init",
	exitCode: EXIT_NEEDS_CONFIRMATION,
	hint: "Pass --force.",
	message: "A config file exists.",
};

describe(createJsonReporter, () => {
	it("should write each event and the result as one JSON line each", () => {
		expect.assertions(1);

		const captured = captureOutput();
		const reporter = createJsonReporter(captured.output);
		reporter.emit({ name: "write config", status: "started", type: "step" });
		reporter.emit({ message: "hello", type: "info" });
		reporter.succeed("init", { data: { path: "/p" }, summary: "done" });

		expect(captured.stdout()).toBe(
			[
				'{"name":"write config","status":"started","type":"step"}',
				'{"message":"hello","type":"info"}',
				'{"type":"result","command":"init","data":{"path":"/p"},"ok":true}',
				"",
			].join("\n"),
		);
	});

	it("should write a failed result with its code and exit code", () => {
		expect.assertions(2);

		const captured = captureOutput();
		createJsonReporter(captured.output).fail(FAILURE);

		expect(captured.jsonLines()).toStrictEqual([
			{
				type: "result",
				command: "init",
				error: {
					code: "needs_confirmation",
					hint: "Pass --force.",
					message: "A config file exists.",
				},
				exitCode: EXIT_NEEDS_CONFIRMATION,
				ok: false,
			},
		]);
		expect(captured.stderr()).toBe("");
	});

	it("should leave out a missing hint", () => {
		expect.assertions(1);

		const captured = captureOutput();
		createJsonReporter(captured.output).fail({ ...FAILURE, hint: undefined });

		expect(captured.jsonLines()).toStrictEqual([
			expect.objectContaining({
				error: { code: "needs_confirmation", message: "A config file exists." },
			}),
		]);
	});
});

describe(createTtyReporter, () => {
	it("should write progress and the summary to stdout", () => {
		expect.assertions(2);

		const captured = captureOutput();
		const reporter = createTtyReporter(captured.output);
		reporter.emit({ message: "hello", type: "info" });
		reporter.emit({ name: "build", status: "started", type: "step" });
		reporter.emit({ name: "build", status: "succeeded", type: "step" });
		reporter.emit({ name: "lint", status: "failed", type: "step" });
		reporter.succeed("init", { data: {}, summary: "Created it." });

		expect(captured.stdout()).toBe("hello\n› build\n✔ build\n✖ lint\nCreated it.\n");
		expect(captured.stderr()).toBe("");
	});

	it("should write warnings to stderr", () => {
		expect.assertions(1);

		const captured = captureOutput();
		createTtyReporter(captured.output).emit({ message: "careful", type: "warning" });

		expect(captured.stderr()).toBe("warning: careful\n");
	});

	it("should write a failure with its code and hint to stderr", () => {
		expect.assertions(2);

		const captured = captureOutput();
		createTtyReporter(captured.output).fail(FAILURE);

		expect(captured.stderr()).toBe(
			"forge: A config file exists. [needs_confirmation]\nhint: Pass --force.\n",
		);
		expect(captured.stdout()).toBe("");
	});

	it("should write a failure without a hint line when there is no hint", () => {
		expect.assertions(1);

		const captured = captureOutput();
		createTtyReporter(captured.output).fail({ ...FAILURE, hint: undefined });

		expect(captured.stderr()).toBe("forge: A config file exists. [needs_confirmation]\n");
	});
});

describe(createReporter, () => {
	it.for([
		[{ json: true, stdoutIsTty: true }, "json"],
		[{ json: false, stdoutIsTty: false }, "json"],
		[{ json: true, stdoutIsTty: false }, "json"],
		[{ json: false, stdoutIsTty: true }, "tty"],
	] as const)("should pick the %o reporter as %s", ([choice, expected]) => {
		expect.assertions(1);

		const captured = captureOutput();
		createReporter(choice, captured.output).emit({ message: "m", type: "info" });

		expect(captured.stdout()).toBe(
			expected === "json" ? '{"message":"m","type":"info"}\n' : "m\n",
		);
	});
});
