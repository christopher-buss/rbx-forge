import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "tsdown";

import { luaTextPlugin } from "./src/loaders/lua-text.ts";
import { PATCHES, VERSION } from "./src/studio/rojo-plugin-manifest.ts";

export default defineConfig({
	clean: true,
	copy({ outDir }) {
		const to = path.join(outDir, "rojo-plugin");
		return [
			{ from: "plugin/ForgePlugin.rbxm", to: path.join(outDir, "forge-plugin") },
			{ from: "src/studio/rojo-plugin/LICENSE.txt", to },
			{ from: "src/studio/rojo-plugin/NOTICE.txt", to },
			{ from: "src/studio/rojo-plugin/stock/App.lua", to: path.join(to, "stock") },
			{ from: "src/studio/rojo-plugin/stock/ServeSession.lua", to: path.join(to, "stock") },
		];
	},
	dts: true,
	entry: ["src/cli.ts", "src/index.ts", "src/supervisor.ts"],
	fixedExtension: true,
	format: ["esm"],
	onSuccess({ outDir }) {
		const directory = path.join(outDir, "rojo-plugin");
		mkdirSync(directory, { recursive: true });
		for (const { name, hash } of PATCHES) {
			const source = readFileSync(`src/studio/rojo-plugin/patched/${name}.lua`, "utf8");
			writeFileSync(
				path.join(directory, `${name}.lua`),
				`-- rbx-forge patch ${VERSION} stock ${hash}\n${source}`,
			);
		}
	},
	plugins: [luaTextPlugin()],
	publint: true,
	target: ["node24.12"],
	// `supervisor.ts` imports the supervisor for its effects; the package says
	// it has none.
	treeshake: {
		moduleSideEffects: (id) => (id.endsWith("supervisor-main.ts") ? true : undefined),
	},
	tsconfig: "tsconfig.lib.json",
	unbundle: false,
});
