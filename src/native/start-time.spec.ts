import { describe, expect, it } from "vitest";

import { startTimeToEpochMs } from "./start-time.ts";

const BOOT = Date.UTC(2026, 0, 1);

describe(startTimeToEpochMs, () => {
	it("should read a Windows FILETIME as 100 ns intervals since 1601", () => {
		expect.assertions(1);

		// 2026-01-01T00:00:00.1234567Z; the sub-millisecond part is dropped.
		expect(startTimeToEpochMs("134116992001234567", "win32", BOOT)).toBe(
			Date.UTC(2026, 0, 1, 0, 0, 0, 123),
		);
	});

	it("should read the Windows epoch as 1601", () => {
		expect.assertions(1);

		expect(startTimeToEpochMs("0", "win32", BOOT)).toBe(Date.UTC(1601, 0, 1));
	});

	it("should read a macOS start time as microseconds since 1970", () => {
		expect.assertions(1);

		expect(startTimeToEpochMs("1767225600123999", "darwin", BOOT)).toBe(
			Date.UTC(2026, 0, 1, 0, 0, 0, 123),
		);
	});

	it("should read a Linux start time as 10 ms ticks since boot", () => {
		expect.assertions(1);

		expect(startTimeToEpochMs("250", "linux", BOOT)).toBe(BOOT + 2500);
	});

	it("should read no start time on another OS", () => {
		expect.assertions(1);

		expect(startTimeToEpochMs("250", "freebsd", BOOT)).toBeUndefined();
	});
});
