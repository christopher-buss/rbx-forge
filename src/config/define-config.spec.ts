import { describe, expect, it } from "vitest";

import { defineConfig } from "./define-config.ts";

describe(defineConfig, () => {
	it("should return the config it was given", () => {
		expect.assertions(1);

		const config = { projectType: "rbxts" as const, rojoPort: 4000 };

		expect(defineConfig(config)).toBe(config);
	});
});
