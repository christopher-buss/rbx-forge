import { describe, expect, it } from "vitest";

import { ForgeError } from "./errors.ts";
import {
	EXIT_CLEANUP_PENDING,
	EXIT_FAILURE,
	EXIT_NEEDS_CONFIRMATION,
	EXIT_USAGE,
} from "./exit-codes.ts";

describe(ForgeError, () => {
	it("should carry its code, message, hint, and cause", () => {
		expect.assertions(4);

		const cause = new Error("root");
		const error = new ForgeError("config_invalid", "bad config", { cause, hint: "fix it" });

		expect(error.code).toBe("config_invalid");
		expect(error.message).toBe("bad config");
		expect(error.hint).toBe("fix it");
		expect(error.cause).toBe(cause);
	});

	it("should leave the hint undefined when none is given", () => {
		expect.assertions(1);

		const error = new ForgeError("usage", "x");

		expect(error.hint).toBeUndefined();
	});

	it.for([
		["config_invalid", EXIT_FAILURE],
		["usage", EXIT_USAGE],
		["needs_confirmation", EXIT_NEEDS_CONFIRMATION],
		["supervisor_unresponsive", EXIT_CLEANUP_PENDING],
	] as const)("should map %s to exit code %i", ([code, exitCode]) => {
		expect.assertions(1);

		const error = new ForgeError(code, "x");

		expect(error.exitCode).toBe(exitCode);
	});
});
