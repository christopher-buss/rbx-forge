import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { readVariable, withVariables } from "../../src/process/environment.ts";

const MISE_TOML = path.join(import.meta.dirname, "../../mise.toml");
const PINNED_ROJO = /"github:rojo-rbx\/rojo"\s*=\s*"(?<version>[^"]+)"/u;

/**
 * Resolve the genuine build/syncback tool outside a fixture's fake PATH.
 * @returns The first `PATH` Rojo that is the version `mise.toml` pins.
 */
export function captureRojo(): string {
	const pinned = PINNED_ROJO.exec(readFileSync(MISE_TOML, "utf8"))?.groups?.["version"];
	assert(pinned !== undefined, "mise.toml pins Rojo");
	const filename = process.platform === "win32" ? "rojo.exe" : "rojo";
	const search = readVariable(process.env, "PATH", process.platform) ?? "";
	const executable = search
		.split(path.delimiter)
		.map((directory) => path.join(directory, filename))
		.find((candidate) => existsSync(candidate) && isPinnedRojo(candidate, pinned));
	assert(executable !== undefined, `Capture e2e tests require Rojo ${pinned} on PATH`);
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

/**
 * A shim such as rokit's defers to the next `rojo` on `PATH`, which in a
 * fixture is the fake, so a candidate must report the version on its own.
 * @param candidate - The executable to run.
 * @param version - The version `mise.toml` pins.
 * @returns Whether the candidate is that Rojo, with only its own directory on
 *   `PATH`.
 */
function isPinnedRojo(candidate: string, version: string): boolean {
	const { status, stdout } = spawnSync(candidate, ["--version"], {
		encoding: "utf8",
		env: withVariables(process.env, { PATH: path.dirname(candidate) }, process.platform),
		timeout: 10_000,
		windowsHide: true,
	});
	return status === 0 && stdout.trim() === `Rojo ${version}`;
}
