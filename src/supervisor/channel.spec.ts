import { describe, expect, it } from "vitest";

import { catchForgeError } from "../../test/helpers/errors.ts";
import type { CommandFailure, ReporterEvent } from "../seams/reporter.ts";
import type { SupervisorMessage } from "./channel.ts";
import {
	createChannelReporter,
	encodeMessage,
	encodeSessionRequest,
	encodeStop,
	failureError,
	parseMessage,
	parseOwnerLine,
	parseSessionRequest,
} from "./channel.ts";

const EVENTS: Array<ReporterEvent> = [
	{
		diagnostics: [
			{
				code: "TS2322",
				column: 7,
				file: "src/a.ts",
				line: 3,
				message: "Type 'string' is not assignable to type 'number'.",
				severity: "error",
			},
			{
				code: "roblox-ts",
				column: null,
				file: null,
				line: null,
				message: "m",
				severity: "warning",
			},
		],
		errors: 1,
		type: "compiled",
	},
	{ message: "ready", type: "info" },
	{ message: "careful", type: "warning" },
	{ name: "rojo serve", status: "started", type: "step" },
];

describe(parseSessionRequest, () => {
	it("should read back what start encodes", () => {
		expect.assertions(1);

		const request = {
			compiler: false,
			config: { syncback: { runOnStart: true } },
			open: true,
		};

		expect(parseSessionRequest(encodeSessionRequest(request))).toStrictEqual(request);
	});

	it("should read back what up encodes", () => {
		expect.assertions(1);

		const request = {
			compiler: true,
			config: {},
			detached: { report: "/r.ndjson" },
			open: false,
		};

		expect(parseSessionRequest(encodeSessionRequest(request))).toStrictEqual(request);
	});

	it("should read back --force, and leave it out when false", () => {
		expect.assertions(2);

		const forced = { compiler: true, config: {}, force: true, open: true };

		expect(parseSessionRequest(encodeSessionRequest(forced))).toStrictEqual(forced);
		expect(parseSessionRequest(JSON.stringify({ ...forced, force: false }))).toStrictEqual({
			compiler: true,
			config: {},
			open: true,
		});
	});

	it.for([
		undefined,
		"",
		"{",
		'{"compiler":true}',
		'{"compiler":1,"config":{},"open":true}',
		'{"compiler":true,"config":{},"force":1,"open":true}',
	])("should fail with internal_error on %j", (text) => {
		expect.assertions(2);

		const error = catchForgeError(() => parseSessionRequest(text));

		expect(error.code).toBe("internal_error");
		expect(error.message).toStartWith("The supervisor got no session request: ");
	});

	it("should fail with internal_error on a config layer the schema rejects", () => {
		expect.assertions(1);

		const config = { gracefulTimeoutMs: "y", rojoPort: "x" };
		const text = JSON.stringify({ compiler: true, config, open: true });
		const error = catchForgeError(() => parseSessionRequest(text));

		expect([error.code, error.message]).toStrictEqual([
			"internal_error",
			[
				"The session request's config is invalid:",
				"gracefulTimeoutMs: gracefulTimeoutMs must be a number (was a string)",
				"rojoPort: rojoPort must be a number (was a string)",
			].join("\n"),
		]);
	});
});

describe(parseOwnerLine, () => {
	it("should read a stop line as its signal", () => {
		expect.assertions(2);

		expect(encodeStop("SIGINT")).toBe('{"signal":"SIGINT","type":"stop"}\n');
		expect(parseOwnerLine(encodeStop("SIGHUP").trimEnd())).toStrictEqual({
			signal: "SIGHUP",
			type: "signal",
		});
	});

	it.for(["", "stop", '{"signal":"SIGKILL","type":"stop"}', '{"signal":"SIGINT"}'])(
		"should ignore %j",
		(line) => {
			expect.assertions(1);

			expect(parseOwnerLine(line)).toBeUndefined();
		},
	);
});

describe(parseMessage, () => {
	it.for(EVENTS)("should read back a $type event", (event) => {
		expect.assertions(1);

		const message: SupervisorMessage = { event, type: "event" };

		expect(parseMessage(encodeMessage(message).trimEnd())).toStrictEqual(message);
	});

	it("should read back both results", () => {
		expect.assertions(2);

		const ok: SupervisorMessage = {
			data: { port: 1 },
			ok: true,
			summary: "done",
			type: "result",
		};
		const failed: SupervisorMessage = {
			error: { code: "port_in_use", details: { port: 1 }, hint: "h", message: "busy" },
			ok: false,
			type: "result",
		};

		expect(parseMessage(encodeMessage(ok))).toStrictEqual(ok);
		expect(parseMessage(encodeMessage(failed))).toStrictEqual(failed);
	});

	it.for([
		"",
		"not json",
		'{"type":"event","event":{"type":"info"}}',
		'{"type":"result","ok":true,"data":{}}',
		'{"type":"result","ok":false,"error":{"code":"x"}}',
		'{"type":"other"}',
	])("should ignore %j", (line) => {
		expect.assertions(1);

		expect(parseMessage(line)).toBeUndefined();
	});
});

describe(createChannelReporter, () => {
	function record() {
		const lines: Array<unknown> = [];
		const reporter = createChannelReporter((text) => {
			lines.push(JSON.parse(text));
		});
		return { lines, reporter };
	}

	it("should write each event as one message line", () => {
		expect.assertions(1);

		const { lines, reporter } = record();
		reporter.emit({ message: "ready", type: "info" });

		expect(lines).toStrictEqual([{ event: { message: "ready", type: "info" }, type: "event" }]);
	});

	it("should write a success as an ok result", () => {
		expect.assertions(1);

		const { lines, reporter } = record();
		reporter.succeed("start", { data: { reason: "SIGINT" }, summary: "Stopped." });

		expect(lines).toStrictEqual([
			{ data: { reason: "SIGINT" }, ok: true, summary: "Stopped.", type: "result" },
		]);
	});

	it("should write a failure with its details and hint only when it has them", () => {
		expect.assertions(1);

		const { lines, reporter } = record();
		const base: Pick<CommandFailure, "command" | "exitCode" | "message"> = {
			command: "start",
			exitCode: 1,
			message: "busy",
		};
		reporter.fail({ ...base, code: "port_in_use", details: { port: 1 }, hint: "free it" });
		reporter.fail({ ...base, code: "internal_error", details: undefined, hint: undefined });

		expect(lines).toStrictEqual([
			{
				error: {
					code: "port_in_use",
					details: { port: 1 },
					hint: "free it",
					message: "busy",
				},
				ok: false,
				type: "result",
			},
			{ error: { code: "internal_error", message: "busy" }, ok: false, type: "result" },
		]);
	});
});

describe(failureError, () => {
	it("should rebuild the error with its code, details, and hint", () => {
		expect.assertions(1);

		const error = failureError({
			code: "session_running",
			details: { a: 1 },
			hint: "stop it",
			message: "running",
		});

		expect([error.code, error.details, error.hint, error.message]).toStrictEqual([
			"session_running",
			{ a: 1 },
			"stop it",
			"running",
		]);
	});

	it("should make an unknown code internal_error, with no details or hint", () => {
		expect.assertions(1);

		const error = failureError({ code: "from_the_future", message: "odd" });

		expect([error.code, error.details, error.hint, error.message]).toStrictEqual([
			"internal_error",
			undefined,
			undefined,
			"odd",
		]);
	});
});
