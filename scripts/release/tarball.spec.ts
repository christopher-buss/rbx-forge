import { describe, expect, it } from "vitest";

import { entryMode, gzippedTarball } from "../../test/helpers/tarball.ts";
import { setEntryMode } from "./tarball.ts";

describe(setEntryMode, () => {
	it("should set the mode of the named entry and keep its checksum valid", () => {
		expect.assertions(2);

		const packed = gzippedTarball([
			{ name: "package/package.json", size: 10 },
			{ name: "package/forge-reaper", size: 600 },
		]);

		const updated = setEntryMode(packed, "package/forge-reaper", 0o755);

		expect(entryMode(updated, 1)).toBe("0000755");
		expect(entryMode(updated, 0)).toBe("0000644");
	});

	it("should find an entry whose path is split into a ustar prefix", () => {
		expect.assertions(1);

		const packed = gzippedTarball([{ name: "forge-reaper", prefix: "package", size: 1 }]);

		expect(entryMode(setEntryMode(packed, "package/forge-reaper", 0o755), 0)).toBe("0000755");
	});

	it("should throw when the entry is missing", () => {
		expect.assertions(1);

		const packed = gzippedTarball([{ name: "package/package.json", size: 1 }]);

		expect(() => setEntryMode(packed, "package/forge-reaper", 0o755)).toThrow(
			"package/forge-reaper is not in the tarball",
		);
	});
});
