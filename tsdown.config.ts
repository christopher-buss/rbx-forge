// cspell:ignore publint
import { defineConfig } from "tsdown";

export default defineConfig({
	clean: true,
	entry: ["src/index.ts"],
	fixedExtension: true,
	format: ["esm"],
	onSuccess() {
		console.info("🙏 Build succeeded!");
	},
	publint: true,
	shims: true,
	unused: {
		level: "error",
	},
});
