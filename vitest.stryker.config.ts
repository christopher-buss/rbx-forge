import { defineConfig } from "vitest/config";

import { luaTextPlugin } from "./src/loaders/lua-text.ts";
import { unitProject } from "./vitest.config.ts";

// Stryker runs one suite: the `unit` project hoisted to the root (the vitest
// runner has no project filter).
export default defineConfig({
	plugins: [luaTextPlugin()],
	test: {
		...unitProject.test,
		// Stryker activates one mutant per run through module state.
		isolate: true,
		pool: "threads",
		typecheck: { enabled: false },
	},
});
