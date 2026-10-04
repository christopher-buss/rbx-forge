/** Put the CLI in a host job after Node initializes its child-process job. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

interface TestAddon {
	joinNewJob: (breakawayOk: boolean) => void;
}

assert.equal(process.env["FIXTURE_STUDIO_PLATFORM_LAUNCHER"], "1");
assert.notEqual(path.basename(process.env["ComSpec"] ?? "cmd.exe").toLowerCase(), "cmd.exe");

// Children run their normal fixture entrypoints.
delete process.env["NODE_OPTIONS"];
spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
const ADDON_PATH = process.env["FIXTURE_NATIVE_ADDON"] ?? "";
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- this fixture loads the test addon
const addon = createRequire(import.meta.url)(ADDON_PATH) as TestAddon;
addon.joinNewJob(false);
