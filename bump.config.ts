import { defineConfig } from "bumpp";

export default defineConfig({
	commit: "chore: release v%s",
	push: true,
	tag: "v%s",
});
