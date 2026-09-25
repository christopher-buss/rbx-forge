/**
 * E2E runs never reach the user's Roblox Studio or its files. Every forge
 * process a test starts inherits this environment:
 *
 * - `RBX_FORGE_STUDIO_PATH` names a file that does not exist, so forge never
 *   finds real Studio (a launch fails with `studio_launch_failed`). A test
 *   that opens a place sets it to a stand-in.
 * - `LOCALAPPDATA`, `USERPROFILE`, and `HOME` point at a scratch home, so
 *   auto-recovery handling never touches the real AutoSaves folders. The
 *   real values stay in `RBX_FORGE_TEST_REAL_<name>` for the opt-in real
 *   Studio test.
 * - `NODE_OPTIONS` is unset (see below).
 */
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const HOME = path.join(os.tmpdir(), "rbx-forge-e2e-home");
mkdirSync(HOME, { recursive: true });
for (const name of ["LOCALAPPDATA", "USERPROFILE", "HOME"]) {
	const real = `RBX_FORGE_TEST_REAL_${name}`;
	process.env[real] ??= process.env[name] ?? "";
}

process.env["LOCALAPPDATA"] = path.join(HOME, "AppData", "Local");
process.env["USERPROFILE"] = HOME;
process.env["HOME"] = HOME;
process.env["RBX_FORGE_STUDIO_PATH"] = path.join(HOME, "no-studio", "RobloxStudioBeta.exe");
// With an `--import` (pnpm adds one), Node loads the main module as ESM, and
// the Studio stand-in's `.rbxl` place no longer runs.
delete process.env["NODE_OPTIONS"];
