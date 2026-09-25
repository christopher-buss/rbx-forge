import { describe, expect, it } from "vitest";

import type { ForgeErrorCode } from "./errors.ts";
import { ERROR_CODES, ForgeError } from "./errors.ts";
import {
	EXIT_CLEANUP_PENDING,
	EXIT_CODE_HELP,
	EXIT_FAILURE,
	EXIT_IDENTITY_UNVERIFIED,
	EXIT_INTERRUPTED,
	EXIT_NEEDS_CONFIRMATION,
	EXIT_NOT_RUNNING,
	EXIT_SUCCESS,
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

	it("should name itself in stack traces", () => {
		expect.assertions(1);

		const error = new ForgeError("usage", "x");

		expect(error.name).toBe("ForgeError");
	});

	it("should leave the hint undefined when none is given", () => {
		expect.assertions(1);

		const error = new ForgeError("usage", "x");

		expect(error.hint).toBeUndefined();
	});

	// The exit code of each class the spec names, written out so that a moved
	// code fails here.
	it.for([
		["config_invalid", EXIT_FAILURE],
		["usage", EXIT_USAGE],
		["not_running", EXIT_NOT_RUNNING],
		["session_replaced", EXIT_NOT_RUNNING],
		["needs_confirmation", EXIT_NEEDS_CONFIRMATION],
		["identity_mismatch", EXIT_IDENTITY_UNVERIFIED],
		["cleanup_unverifiable", EXIT_IDENTITY_UNVERIFIED],
		["cleanup_in_progress", EXIT_CLEANUP_PENDING],
		["supervisor_unresponsive", EXIT_CLEANUP_PENDING],
		["previous_generation_alive", EXIT_CLEANUP_PENDING],
		["interrupted", EXIT_INTERRUPTED],
	] as const)("should map %s to exit code %i", ([code, exitCode]) => {
		expect.assertions(1);

		const error = new ForgeError(code, "x");

		expect(error.exitCode).toBe(exitCode);
	});
});

function isErrorCode(key: string): key is ForgeErrorCode {
	return Object.hasOwn(ERROR_CODES, key);
}

const ALL_CODES = Object.keys(ERROR_CODES).filter(isErrorCode);
const DOCUMENTED_EXIT_CODES = new Set(EXIT_CODE_HELP.map(([code]) => code));

describe("error codes", () => {
	it.for(ALL_CODES)("should give %s a documented exit code other than success", (code) => {
		expect.assertions(2);

		const { exitCode } = ERROR_CODES[code];

		expect(DOCUMENTED_EXIT_CODES.has(exitCode)).toBeTrue();
		expect(exitCode).not.toBe(EXIT_SUCCESS);
	});

	it.for(ALL_CODES)("should describe %s in one sentence", (code) => {
		expect.assertions(1);

		expect(ERROR_CODES[code].text).toMatch(/^[A-Z`][^\n]*\.$/);
	});
});
