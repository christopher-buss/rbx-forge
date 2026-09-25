import { describe, expect, it } from "vitest";

import { nodeClock } from "./clock.ts";

describe("node clock", () => {
	it("should read the wall clock", () => {
		expect.assertions(2);

		const before = Date.now();
		const now = nodeClock.now();

		expect(now).toBeGreaterThanOrEqual(before);
		expect(now).toBeLessThanOrEqual(Date.now());
	});

	it("should resolve after the wait", async () => {
		expect.assertions(1);

		await expect(nodeClock.sleep(1)).resolves.toBeUndefined();
	});

	it("should reject when the signal aborts", async () => {
		expect.assertions(1);

		await expect(nodeClock.sleep(60_000, AbortSignal.abort())).rejects.toMatchObject({
			name: "AbortError",
		});
	});
});
