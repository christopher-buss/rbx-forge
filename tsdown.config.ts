// cspell:ignore publint
import path from "node:path";
import { defineConfig } from "tsdown";

export default defineConfig({
	alias: {
		src: path.resolve(import.meta.dirname, "src"),
	},
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
		level: "warning",
	},
});
