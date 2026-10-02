import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "tsdown";

import { SCRIPTS, VERSION } from "./src/studio/rojo-plugin.ts";

export default defineConfig({
	clean: true,
	copy({ outDir }) {
		const to = path.join(outDir, "rojo-plugin");
		return [
			{ from: "src/studio/rojo-plugin/LICENSE.txt", to },
			{ from: "src/studio/rojo-plugin/NOTICE.txt", to },
			{ from: "src/studio/rojo-plugin/stock.json", to },
		];
	},
	dts: true,
	entry: ["src/cli.ts", "src/index.ts", "src/supervisor.ts"],
	fixedExtension: true,
	format: ["esm"],
	onSuccess({ outDir }) {
		const directory = path.join(outDir, "rojo-plugin");
		mkdirSync(directory, { recursive: true });
		for (const { name, hash, source } of SCRIPTS) {
			writeFileSync(
				path.join(directory, `${name}.lua`),
				`-- rbx-forge patch ${VERSION} stock ${hash}\n${source}`,
			);
		}
	},
	publint: true,
	target: ["node24.12"],
	tsconfig: "tsconfig.lib.json",
	unbundle: false,
});
