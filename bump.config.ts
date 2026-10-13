import { defineConfig } from "bumpp";

import { assertStable } from "./scripts/release/release.ts";

export default defineConfig({
	commit: "chore: release v%s",
	/**
	 * After the gate, before the commit and tag: a tag releases stable only.
	 * @param context - The release state.
	 */
	execute: (context) => {
		assertStable(context.state.newVersion);
	},
	push: true,
	tag: "v%s",
});
