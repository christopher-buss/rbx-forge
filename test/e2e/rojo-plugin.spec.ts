import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { parseResult } from "../helpers/output.ts";
import { loadRealNative } from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";
import { readWorkerLog } from "../helpers/worker-log.ts";
import { runBinAsync } from "./run-bin.ts";
import { makeFixtureAsync, START_STUDIO, STUDIO_PROJECT } from "./session-fixture.ts";

function pluginWithWrongProtocol(home: string): string {
	const directory =
		process.platform === "win32"
			? path.join(home, "AppData", "Local", "Roblox", "Plugins")
			: path.join(home, "Documents", "Roblox", "Plugins");
	const model = path.join(directory, "RojoManagedPlugin.rbxm");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		model,
		gunzipSync(
			readFileSync(path.join(import.meta.dirname, "../fixtures/models/rojo-7.7.1.rbxm.gz")),
		),
	);
	const native = loadRealNative();
	const scriptPath = ["Rojo", "Plugin", "Config"];
	const [source] = native.readModelScriptSources(model, [scriptPath]);
	native.writeModelScriptSources(model, [
		{ path: scriptPath, source: source!.replace("protocolVersion = 5", "protocolVersion = 6") },
	]);
	return model;
}

describe.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
	"cli plugin lifecycle",
	() => {
		it("should report protocol mismatch as exit 7 without changing the model or starting Studio", async () => {
			expect.assertions(4);

			const fixture = await makeFixtureAsync(STUDIO_PROJECT);
			const home = makeTemporaryDirectory();
			const model = pluginWithWrongProtocol(home);
			const previous = readFileSync(model);
			const run = await runBinAsync(
				START_STUDIO,
				fixture.project,
				fixture.environment({ HOME: home, USERPROFILE: home }),
			);

			expect(run.status).toBe(7);
			expect(parseResult(run.stdout)).toMatchObject({
				error: { code: "plugin_protocol_mismatch" },
				exitCode: 7,
				ok: false,
			});
			expect(readFileSync(model)).toStrictEqual(previous);
			expect(
				readWorkerLog(fixture.log).filter(({ role }) => role === "studio"),
			).toStrictEqual([]);
		});
	},
);
