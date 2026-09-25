import { defineConfig } from "tsdown";

export default defineConfig({
	clean: true,
	dts: true,
	entry: ["src/cli.ts", "src/index.ts", "src/supervisor.ts"],
	fixedExtension: true,
	format: ["esm"],
	publint: true,
	target: ["node24.12"],
	tsconfig: "tsconfig.lib.json",
	unbundle: false,
});
