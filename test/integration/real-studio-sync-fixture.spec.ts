import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SCRIPTS, VERSION } from "../../src/studio/rojo-plugin.ts";
import { loadRealNative } from "../helpers/real-native.ts";
import { installSyncModelAsync, prepareSyncModel } from "../helpers/real-studio-sync-fixture.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";

const native = loadRealNative();

describe("real Studio sync plugin isolation", () => {
	it("should gate the separate test plugin before loading Rojo and preserve the managed plugin", async () => {
		expect.assertions(5);

		const directory = makeTemporaryDirectory();
		const managed = path.join(directory, "RojoManagedPlugin.rbxm");
		writeFileSync(managed, "unrelated managed plugin");
		const model = prepareSyncModel(native, directory, {
			port: 12345,
			projectName: "owned-project",
			token: "owned-launch-token",
		});
		const [bootstrap] = native.readModelScriptSources(model, [["Rojo", "Plugin"]]);

		expect(path.basename(model)).not.toBe("RojoManagedPlugin.rbxm");
		expect(bootstrap).toStartWith(
			"-- Test plugin: only the matching RunScript launch may load Rojo.\n",
		);
		expect(bootstrap).toContain(
			'game:GetAttribute("__ForgeSyncTestLaunch") ~= "owned-launch-token"',
		);

		expect(
			native.readModelScriptSources(
				model,
				SCRIPTS.map(({ name }) => ["Rojo", "Plugin", name]),
			),
		).toStrictEqual(
			SCRIPTS.map(({ hash, source }) => {
				return `-- rbx-forge patch ${VERSION} stock ${hash}\n${source.replaceAll("ROJO_OPEN_", "FORGE_SYNC_TEST_owned-launch-token_")}`;
			}),
		);

		await installSyncModelAsync(
			{ didInstall: false, plugin: path.join(directory, "plugins", "test.rbxm") },
			model,
		);

		expect(readFileSync(managed, "utf8")).toBe("unrelated managed plugin");
	});
});
