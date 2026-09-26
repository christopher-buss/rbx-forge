import { describe, expect, it } from "vitest";

import { createManualClock } from "../../test/helpers/manual-clock.ts";
import { nodeClock, settlesWithinAsync } from "./clock.ts";

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

describe(settlesWithinAsync, () => {
	it("should be true when the promise settles first, leaving no timer", async () => {
		expect.assertions(2);

		const { clock, pending } = createManualClock();

		await expect(settlesWithinAsync(clock, Promise.resolve(), 1000)).resolves.toBeTrue();
		expect(pending()).toBe(0);
	});

	it("should be false when the limit passes first", async () => {
		expect.assertions(1);

		const manual = createManualClock();
		const waiting = settlesWithinAsync(manual.clock, new Promise(() => {}), 1000);
		manual.advance(1000);

		await expect(waiting).resolves.toBeFalse();
	});

	it("should be false at once when hurried", async () => {
		expect.assertions(1);

		const { clock } = createManualClock();

		await expect(
			settlesWithinAsync(clock, new Promise(() => {}), 1000, AbortSignal.abort()),
		).resolves.toBeFalse();
	});
});
