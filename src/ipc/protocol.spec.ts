import { describe, expect, it } from "vitest";

import { encodeLine, parseHello, parseRequest, parseResponse } from "./protocol.ts";

describe(encodeLine, () => {
	it("should write one JSON object and a newline", () => {
		expect.assertions(1);

		expect(encodeLine({ protocol: 1, token: "t", type: "hello" })).toBe(
			'{"protocol":1,"token":"t","type":"hello"}\n',
		);
	});
});

describe(parseHello, () => {
	it("should read a hello back", () => {
		expect.assertions(1);

		expect(parseHello('{"protocol":1,"token":"t","type":"hello"}')).toStrictEqual({
			protocol: 1,
			token: "t",
			type: "hello",
		});
	});

	it.for([
		["not JSON", "hello"],
		["another type", '{"protocol":1,"token":"t","type":"request"}'],
		["no token", '{"protocol":1,"type":"hello"}'],
	] as const)("should read %s as no hello", ([, line]) => {
		expect.assertions(1);

		expect(parseHello(line)).toBeUndefined();
	});
});

describe(parseRequest, () => {
	it("should read a request, with no params as empty params", () => {
		expect.assertions(2);

		expect(parseRequest('{"method":"status","type":"request"}')).toStrictEqual({
			method: "status",
			params: {},
			type: "request",
		});
		expect(
			parseRequest('{"method":"shutdown","params":{"force":true},"type":"request"}'),
		).toStrictEqual({ method: "shutdown", params: { force: true }, type: "request" });
	});

	it.for([
		["not JSON", "{"],
		["an unknown method", '{"method":"exec","type":"request"}'],
		["a hello", '{"protocol":1,"token":"t","type":"hello"}'],
	] as const)("should read %s as no request", ([, line]) => {
		expect.assertions(1);

		expect(parseRequest(line)).toBeUndefined();
	});
});

describe(parseResponse, () => {
	it("should read a success and a failure", () => {
		expect.assertions(2);

		expect(parseResponse('{"ok":true,"result":{"a":1},"type":"response"}')).toStrictEqual({
			ok: true,
			result: { a: 1 },
			type: "response",
		});
		expect(
			parseResponse(
				'{"error":{"code":"x","hint":"h","message":"m"},"ok":false,"type":"response"}',
			),
		).toStrictEqual({
			error: { code: "x", hint: "h", message: "m" },
			ok: false,
			type: "response",
		});
	});

	it.for([
		["not JSON", ""],
		["a success without a result", '{"ok":true,"type":"response"}'],
		["a failure without a message", '{"error":{"code":"x"},"ok":false,"type":"response"}'],
	] as const)("should read %s as no response", ([, line]) => {
		expect.assertions(1);

		expect(parseResponse(line)).toBeUndefined();
	});
});
