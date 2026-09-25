import { assert } from "vitest";

import { ForgeError } from "../../src/errors.ts";

/**
 * Run `action` and return the `ForgeError` it throws. Fails the test when it
 * throws nothing or something else.
 *
 * @param action - Code expected to throw.
 * @returns The thrown error.
 */
export function catchForgeError(action: () => unknown): ForgeError {
	try {
		action();
	} catch (err) {
		assert(err instanceof ForgeError, "expected a ForgeError");
		return err;
	}

	assert.fail("expected a ForgeError, but nothing was thrown");
}
