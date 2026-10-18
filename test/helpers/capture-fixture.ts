import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { readVariable } from "../../src/process/environment.ts";

/**
 * Resolve the genuine build/syncback tool outside a fixture's fake PATH.
 * @returns The genuine executable path.
 */
export function captureRojo(): string {
	const filename = process.platform === "win32" ? "rojo.exe" : "rojo";
	const search = readVariable(process.env, "PATH", process.platform) ?? "";
	const executable = search
		.split(path.delimiter)
		.map((directory) => path.join(directory, filename))
		.find((candidate) => existsSync(candidate));
	assert(executable !== undefined, "Capture e2e tests require the project's pinned Rojo");
	return executable;
}

/**
 * Build the model the stand-in posts, using the same binary format as Studio.
 * @param project - The fixture project directory.
 * @param rojo - The genuine Rojo executable.
 * @returns The binary model path.
 */
export function makeCaptureModel(project: string, rojo: string): string {
	const directory = path.join(project, "capture-model");
	mkdirSync(directory, { recursive: true });
	const file = path.join(directory, "capture.project.json");
	writeFileSync(
		file,
		JSON.stringify({
			name: "Edited",
			tree: {
				$className: "Folder",
				ChangedScript: {
					$className: "ModuleScript",
					$properties: { Source: "return 'captured edit'" },
				},
				NewPart: { $className: "Part", $properties: { Anchored: true } },
			},
		}),
	);
	const model = path.join(directory, "capture.rbxm");
	const built = spawnSync(rojo, ["build", file, "--output", model], {
		encoding: "utf8",
		windowsHide: true,
	});
	assert.equal(built.status, 0, built.stderr);
	return model;
}
