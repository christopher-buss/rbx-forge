import { describe, expect, it } from "vitest";

import { captureOutput } from "../../test/helpers/output.ts";
import type { Diagnostic } from "../compiler/diagnostics.ts";
import { EXIT_NEEDS_CONFIRMATION } from "../exit-codes.ts";
import type { CommandFailure } from "../seams/reporter.ts";
import {
	COMPILE_VIEW_LINES,
	createJsonReporter,
	createReporter,
	createTtyReporter,
} from "./reporters.ts";

const DIAGNOSTIC: Diagnostic = {
	code: "TS2322",
	column: 7,
	file: "src/a.ts",
	line: 3,
	message: "Bad.",
	severity: "error",
};

const FAILURE: CommandFailure = {
	code: "needs_confirmation",
	command: "init",
	details: undefined,
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

	it("should write the details of a failure", () => {
		expect.assertions(1);

		const captured = captureOutput();
		createJsonReporter(captured.output).fail({ ...FAILURE, details: { hooks: [] } });

		expect(captured.jsonLines()).toStrictEqual([
			expect.objectContaining({
				error: expect.objectContaining({ details: { hooks: [] } }),
			}),
		]);
	});

	it("should write a null command when no command was read", () => {
		expect.assertions(1);

		const captured = captureOutput();
		createJsonReporter(captured.output).fail({ ...FAILURE, command: undefined });

		expect(captured.jsonLines()).toStrictEqual([expect.objectContaining({ command: null })]);
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

	it("should write a clean watch-mode compile as one line", () => {
		expect.assertions(1);

		const captured = captureOutput();
		createTtyReporter(captured.output).emit({ diagnostics: [], errors: 0, type: "compiled" });

		expect(captured.stdout()).toBe("✔ compiled: 0 errors, 0 warnings\n");
	});

	it("should write one line per diagnostic of a compile, the first message line only", () => {
		expect.assertions(1);

		const captured = captureOutput();
		createTtyReporter(captured.output).emit({
			diagnostics: [
				{ ...DIAGNOSTIC, message: "Type 'x' is wrong.\n  More detail." },
				{ ...DIAGNOSTIC, column: null, file: null, line: null, severity: "warning" },
			],
			errors: 1,
			type: "compiled",
		});

		expect(captured.stdout()).toBe(
			[
				"✖ compiled: 1 error, 1 warning",
				"  src/a.ts:3:7 error TS2322: Type 'x' is wrong.",
				"  warning TS2322: Bad.",
				"",
			].join("\n"),
		);
	});

	it("should show at most a bounded number of diagnostics per compile", () => {
		expect.assertions(2);

		const captured = captureOutput();
		const diagnostics = Array.from({ length: COMPILE_VIEW_LINES + 5 }, () => DIAGNOSTIC);
		createTtyReporter(captured.output).emit({ diagnostics, errors: 25, type: "compiled" });
		const lines = captured.stdout().trimEnd().split("\n");

		expect(lines).toHaveLength(COMPILE_VIEW_LINES + 2);
		expect(lines.at(-1)).toBe("  ... and 5 more in the compiler log");
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
