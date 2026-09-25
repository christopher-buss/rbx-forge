import { describe, expect, it } from "vitest";

import { formatHookStack, hookId, readHookStack } from "./hook-stack.ts";

describe(hookId, () => {
	it("should name the command, phase, and index", () => {
		expect.assertions(1);

		expect(hookId("syncback", "post", 2)).toBe("syncback:post:2");
	});
});

describe(readHookStack, () => {
	it("should be empty outside any hook", () => {
		expect.assertions(1);

		expect(readHookStack({}, "linux")).toStrictEqual([]);
	});

	it("should read the ids outermost first, ignoring empty entries", () => {
		expect.assertions(1);

		expect(
			readHookStack({ RBX_FORGE_HOOK_STACK: "open:pre:0,,build:post:1" }, "linux"),
		).toStrictEqual(["open:pre:0", "build:post:1"]);
	});

	it("should read the variable in any case on Windows", () => {
		expect.assertions(1);

		expect(readHookStack({ rbx_forge_hook_stack: "build:pre:0" }, "win32")).toStrictEqual([
			"build:pre:0",
		]);
	});

	it("should read what formatHookStack wrote", () => {
		expect.assertions(1);

		const stack = ["open:pre:0", "build:post:0"];

		expect(
			readHookStack({ RBX_FORGE_HOOK_STACK: formatHookStack(stack) }, "linux"),
		).toStrictEqual(stack);
	});
});
