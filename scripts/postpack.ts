#!/usr/bin/env bun

/**
 * Post packaging script that restores patchedDependencies to package.json after
 * npm pack/publish completes.
 */

import { type } from "arktype";
import path from "node:path";

const PROJECT_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, "package.json");

const isValidJson = type({
	"patchedDependencies?": "Record<string, string>",
});

const packageJson = await Bun.file(PACKAGE_JSON_PATH)
	.json()
	.then((value) => isValidJson.assert(value));

// Restore patchedDependencies
packageJson.patchedDependencies = {
	"giget@2.0.0": "patches/giget@2.0.0.patch",
};

await Bun.write(PACKAGE_JSON_PATH, `${JSON.stringify(packageJson, undefined, "\t")}\n`);

console.info("✓ Restored patchedDependencies to package.json");
