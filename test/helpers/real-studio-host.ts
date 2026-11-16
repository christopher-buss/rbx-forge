import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";

import { createNodeSeams } from "../../src/seams/node-seams.ts";
import type { StudioHost } from "../../src/seams/studio-host.ts";
import { NATIVE_DIRECTORY } from "./real-native.ts";

let host: StudioHost | undefined;

/**
 * Use Windows handles for Studio even when the test runner is Linux.
 * @returns The genuine process-local Studio host, never a fake helper.
 */
export function realStudioHost(): StudioHost {
	assert(
		process.env["RBX_FORGE_TEST_WINDOWS_HELPER"] === undefined,
		"Real Studio ownership requires the actual Windows helper",
	);
	host ??= createNodeSeams({
		forgePluginPath: path.join(import.meta.dirname, "../../dist/forge-plugin/ForgePlugin.rbxm"),
		input: process.stdin,
		nativeDirectory: process.env["RBX_FORGE_NATIVE_DIR"] ?? NATIVE_DIRECTORY,
		noInstalledStudio: false,
		output: process.stdout,
		supervisorEntry: path.join(import.meta.dirname, "../../dist/supervisor.mjs"),
	}).studioHost;
	return host;
}
