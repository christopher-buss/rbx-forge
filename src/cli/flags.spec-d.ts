import { describe, expectTypeOf, it } from "vitest";

import type { ConfigOptionPath, FlagDefinition } from "./flags.ts";

describe("flag definition", () => {
	it("should have no default, so precedence stays with the config", () => {
		expectTypeOf<FlagDefinition>().not.toHaveProperty("default");
	});

	it("should map only to options that hold a value", () => {
		expectTypeOf<"typegen.include">().toExtend<ConfigOptionPath>();
		expectTypeOf<"hooks.build.pre">().toExtend<ConfigOptionPath>();
		expectTypeOf<"typegen">().not.toExtend<ConfigOptionPath>();
		expectTypeOf<"serve">().not.toExtend<ConfigOptionPath>();
	});
});
