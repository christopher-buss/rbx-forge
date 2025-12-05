#!/usr/bin/env bun

/**
 * Prepack script that:
 *
 * 1. Runs the build
 * 2. Strips patchedDependencies from package.json for publishing.
 *
 * PatchedDependencies is a dev-time concern - consumers don't need it since
 * everything is bundled into dist/.
 */

import { type } from "arktype";
import path from "node:path";
import { exit } from "node:process";

const PROJECT_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, "package.json");

// Run build first
const buildResult = await Bun.$`bun run ./scripts/build.ts --clean --dts`.nothrow();
if (buildResult.exitCode !== 0) {
	exit(buildResult.exitCode);
}

const isValidJson = type({
	"patchedDependencies?": "Record<string, string>",
});

// Strip patchedDependencies from package.json
const packageJson = await Bun.file(PACKAGE_JSON_PATH)
	.json()
	.then((value) => isValidJson.assert(value));
delete packageJson.patchedDependencies;

await Bun.write(PACKAGE_JSON_PATH, `${JSON.stringify(packageJson, undefined, "\t")}\n`);

console.info("✓ Stripped patchedDependencies from package.json for publishing");
