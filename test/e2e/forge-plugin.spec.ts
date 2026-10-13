import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { EXIT_SUCCESS } from "../../src/exit-codes.ts";
import { studioPlaceContent } from "../fixtures/bin/studio-stand-in.ts";
import { makeFixtureProject } from "../helpers/fixture-project.ts";
import { parseResult } from "../helpers/output.ts";
import { NATIVE_DIRECTORY } from "../helpers/real-native.ts";
import { readWorkerLog } from "../helpers/worker-log.ts";
import type { BinRun } from "./run-bin.ts";

const BUNDLED = path.join(import.meta.dirname, "../../dist/forge-plugin/ForgePlugin.rbxm");
const PLACE = "game.rbxl";

interface PluginFixture {
	/** Open a snapshot, then wait for its stand-in Studio to start. */
	open: () => Promise<BinRun>;
	plugin: string;
}

async function waitForStudiosAsync(log: string, count: number): Promise<void> {
	const deadline = Date.now() + 20_000;
	function started(): number {
		return readWorkerLog(log).filter(({ role }) => role === "studio").length;
	}

	while (started() < count && Date.now() < deadline) {
		await sleep(100);
	}

	expect(started(), "the stand-in Studios started").toBe(count);
}

function makePluginFixture(): PluginFixture {
	const fixture = makeFixtureProject({ config: { buildOutputPath: PLACE, projectType: "luau" } });
	const home = path.join(fixture.project, "home");
	let opened = 0;
	const plugin =
		process.platform === "win32"
			? path.join(home, "AppData", "Local", "Roblox", "Plugins", "ForgePlugin.rbxm")
			: path.join(home, "Documents", "Roblox", "Plugins", "ForgePlugin.rbxm");
	return {
		open: async () => {
			const run = await fixture.forge(["open", "--json"], {
				FIXTURE_PLACE_CONTENT: studioPlaceContent(),
				HOME: home,
				LOCALAPPDATA: path.join(home, "AppData", "Local"),
				RBX_FORGE_NATIVE_DIR: NATIVE_DIRECTORY,
				RBX_FORGE_STUDIO_PATH: process.execPath,
				USERPROFILE: home,
			});
			opened += 1;
			await waitForStudiosAsync(fixture.log, opened);
			return run;
		},
		plugin,
	};
}

describe.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
	"cli forge plugin install",
	() => {
		it("should install the bundled plugin before a direct snapshot launch", async () => {
			expect.assertions(4);

			const { open, plugin } = makePluginFixture();
			const run = await open();

			expect(run.status).toBe(EXIT_SUCCESS);
			expect(parseResult(run.stdout)).toMatchObject({ ok: true });
			expect(readFileSync(plugin)).toStrictEqual(readFileSync(BUNDLED));
		});

		it("should replace an outdated plugin and leave a current one unwritten", async () => {
			expect.assertions(5);

			const { open, plugin } = makePluginFixture();
			mkdirSync(path.dirname(plugin), { recursive: true });
			writeFileSync(plugin, "old");
			await open();

			expect(readFileSync(plugin)).toStrictEqual(readFileSync(BUNDLED));

			utimesSync(plugin, 1000, 1000);
			const run = await open();

			expect(run.status).toBe(EXIT_SUCCESS);
			expect(statSync(plugin).mtimeMs).toBe(1_000_000);
		});
	},
);
