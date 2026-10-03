import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
	launch,
	makeProjectAsync,
	native,
	START_STUDIO,
	studioEnvironment,
	waitForReadyAsync,
} from "./session-harness.ts";

function managedDirectory(home: string): string {
	return process.platform === "win32"
		? path.join(home, "AppData", "Local", "Roblox", "Plugins")
		: path.join(home, "Documents", "Roblox", "Plugins");
}

describe.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
	"managed Rojo plugin",
	() => {
		it("should patch a real stock model coherently before a session opens Studio", async () => {
			expect.assertions(3);

			const project = await makeProjectAsync();
			const environment = studioEnvironment(project);
			const home = environment["USERPROFILE"]!;
			const directory = managedDirectory(home);
			const model = path.join(directory, "RojoManagedPlugin.rbxm");
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				model,
				gunzipSync(
					readFileSync(
						path.join(import.meta.dirname, "../fixtures/models/rojo-7.7.1.rbxm.gz"),
					),
				),
			);
			const originalConfig = native.readModelScriptSources(model, [
				["Rojo", "Plugin", "Config"],
			]);
			const run = launch(project, START_STUDIO, environment);
			await waitForReadyAsync(run);
			run.stop("SIGINT");
			await run.settled;
			const [app, session] = native.readModelScriptSources(model, [
				["Rojo", "Plugin", "App"],
				["Rojo", "Plugin", "ServeSession"],
			]);

			expect(app).toStartWith(
				"-- rbx-forge patch 3 stock f7facea2cd39479ede1349b0042633c8228b8a41d602831f1928a1e43f7b1f15\n",
			);
			expect(session).toStartWith(
				"-- rbx-forge patch 3 stock e7a8fe67a0ff8229d13680fedfec2228fc2d23561bf2a512d1032bb7517c111a\n",
			);
			expect(
				native.readModelScriptSources(model, [["Rojo", "Plugin", "Config"]]),
			).toStrictEqual(originalConfig);
		});
	},
);
