import { describe, expect, it } from "vitest";

import { encodeRequest, parseEvent } from "./protocol.ts";

const REPORT = { exitCode: 0, forced: false, incomplete: false, signal: null };

describe(encodeRequest, () => {
	it("should write a control request as one JSON line", () => {
		expect.assertions(3);

		expect(encodeRequest({ type: "go" })).toBe('{"type":"go"}\n');
		expect(encodeRequest({ id: "rojo", graceMs: 250, type: "stop" })).toBe(
			'{"id":"rojo","graceMs":250,"type":"stop"}\n',
		);
		expect(encodeRequest({ graceMs: 0, type: "terminate" })).toBe(
			'{"graceMs":0,"type":"terminate"}\n',
		);
	});

	it("should write a spawn with defined variables only and verbatim off by default", () => {
		expect.assertions(1);

		const line = encodeRequest({
			type: "spawn",
			worker: {
				id: "rojo",
				args: ["serve"],
				cwd: "/project",
				env: { HOME: "/home", UNSET: undefined },
				file: "/bin/rojo",
				log: "/project/.forge/logs/rojo.log",
			},
		});

		expect(JSON.parse(line)).toStrictEqual({
			id: "rojo",
			args: ["serve"],
			cwd: "/project",
			env: { HOME: "/home" },
			file: "/bin/rojo",
			log: "/project/.forge/logs/rojo.log",
			type: "spawn",
			verbatim: false,
		});
	});

	it("should pass verbatim arguments on and leave out a missing log", () => {
		expect.assertions(2);

		const line = encodeRequest({
			type: "spawn",
			worker: {
				id: "hook",
				args: ["/c", '"x"'],
				cwd: "C:\\p",
				env: {},
				file: "C:\\cmd.exe",
				verbatimArguments: true,
			},
		});

		expect(line.endsWith("}\n")).toBeTrue();
		expect(JSON.parse(line)).toStrictEqual({
			id: "hook",
			args: ["/c", '"x"'],
			cwd: "C:\\p",
			env: {},
			file: "C:\\cmd.exe",
			type: "spawn",
			verbatim: true,
		});
	});
});

describe(parseEvent, () => {
	it("should read every event the reaper writes", () => {
		expect.assertions(5);

		expect(parseEvent('{"type":"leased","pid":4}')).toStrictEqual({ pid: 4, type: "leased" });
		expect(parseEvent('{"type":"spawned","id":"a","pid":5,"startTime":"9"}')).toStrictEqual({
			id: "a",
			pid: 5,
			startTime: "9",
			type: "spawned",
		});
		expect(
			parseEvent('{"type":"rejected","id":"a","reason":"terminating","message":"no"}'),
		).toStrictEqual({ id: "a", message: "no", reason: "terminating", type: "rejected" });
		expect(
			parseEvent(JSON.stringify({ id: "a", report: REPORT, type: "exited" })),
		).toStrictEqual({ id: "a", report: REPORT, type: "exited" });
		expect(
			parseEvent(
				JSON.stringify({ reports: [{ id: "a", report: REPORT }], type: "terminated" }),
			),
		).toStrictEqual({ reports: [{ id: "a", report: REPORT }], type: "terminated" });
	});

	it.for([
		["not JSON", "leased"],
		["an unknown type", '{"type":"exploded"}'],
		["a bad reason", '{"type":"rejected","id":"a","reason":"tired","message":"m"}'],
		["a report without flags", '{"type":"exited","id":"a","report":{"exitCode":0}}'],
		["a fractional pid", '{"type":"leased","pid":1.5}'],
	] as const)("should return undefined for %s", ([, line]) => {
		expect.assertions(1);

		expect(parseEvent(line)).toBeUndefined();
	});
});
