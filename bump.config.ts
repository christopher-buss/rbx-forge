import { defineConfig } from "bumpp";

import { assertStable } from "./scripts/release/release.ts";

export default defineConfig({
	commit: "chore: release v%s",
	/**
	 * After the gate, before the commit and tag: a tag releases stable only.
	 */
	execute: ({ state }) => {
		assertStable(state.newVersion);
	},
	push: true,
	tag: "v%s",
});
