import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export function installWslPlugin(
	args: ReadonlyArray<string>,
	environment: NodeJS.ProcessEnv,
): boolean {
	if (args[0] === "plugin" && environment["FIXTURE_WSL_PLUGIN"] === "1") {
		const home = environment["HOME"];
		const studio = environment["ROBLOX_STUDIO_PATH"];
		assert(home !== undefined && studio !== undefined);
		assert(statSync(path.join(home, "AppData/Local/Roblox")).isDirectory());
		assert(statSync(path.join(studio, "content")).isDirectory());
		const folder = path.join(home, "AppData/Local/Roblox/Plugins");
		mkdirSync(folder);
		writeFileSync(
			path.join(folder, "RojoManagedPlugin.rbxm"),
			gunzipSync(
				readFileSync(path.join(import.meta.dirname, "../models/rojo-7.7.1.rbxm.gz")),
			),
		);
		return true;
	}

	return false;
}
