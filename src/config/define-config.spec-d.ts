import { describe, expectTypeOf, it } from "vitest";

import { defineConfig } from "./define-config.ts";
import type { ForgeConfig } from "./schema.ts";

describe(defineConfig, () => {
	it("should require the project type", () => {
		// @ts-expect-error -- `projectType` is required.
		defineConfig({ rojoPort: 4000 });
	});

	it("should reject an unknown key", () => {
		// @ts-expect-error -- unknown keys are errors.
		defineConfig({ projectType: "rbxts", serve: true });
	});

	it("should type hooks by command", () => {
		expectTypeOf<NonNullable<ForgeConfig["hooks"]>>().toHaveProperty("build");

		// @ts-expect-error -- `serve` has no hooks.
		defineConfig({ hooks: { serve: { pre: [] } }, projectType: "rbxts" });
	});
});
