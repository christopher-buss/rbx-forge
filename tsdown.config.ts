import { defineConfig } from "tsdown";

export default defineConfig({
	clean: true,
	entry: ["src/cli.ts"],
	fixedExtension: true,
	format: ["esm"],
	publint: true,
	target: ["node24.12"],
	unbundle: false,
});
