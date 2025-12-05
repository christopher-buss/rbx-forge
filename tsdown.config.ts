// cspell:ignore publint
import { readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "tsdown";

export default defineConfig({
	clean: true,
	entry: ["src/index.ts"],
	fixedExtension: true,
	format: ["esm"],
	onSuccess() {
		// Replace node shebang with bun shebang
		const outputPath = "dist/index.mjs";
		const content = readFileSync(outputPath, "utf8");
		const fixed = content.replace("#!/usr/bin/env node", "#!/usr/bin/env bun");
		writeFileSync(outputPath, fixed);
		console.info("🙏 Build succeeded!");
	},
	publint: true,
	shims: true,
	unused: {
		level: "warning",
	},
});
