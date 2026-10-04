import { defineConfig } from "bumpp";

export default defineConfig({
	commit: "chore: release v%s",
	/**
	 * After the gate, before the commit and tag: a tag releases stable only.
	 */
	execute: ({ state }) => {
		if (state.newVersion.includes("-")) {
			throw new Error(`a tag releases a stable version only, not ${state.newVersion}`);
		}
	},
	push: true,
	tag: "v%s",
});
