import { spawnSync } from "node:child_process";
import { copyFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { assert, describe, it } from "vitest";

import { loadRealNative } from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";

const native = loadRealNative();
const FIXTURE = path.join(import.meta.dirname, "../fixtures/models/scripts.rbxm");
const SERVICES = JSON.stringify([{ name: "ServerScriptService", roots: [0] }]);

function makeAssembly(): { base: string; capture: Uint8Array; directory: string; output: string } {
	const directory = makeTemporaryDirectory({
		"base.project.json": JSON.stringify({
			name: "CaptureAssembly",
			tree: {
				$className: "DataModel",
				ServerScriptService: {
					$className: "ServerScriptService",
					NativeModelFixture: {
						$className: "Folder",
						App: {
							$className: "ModuleScript",
							$properties: { Source: "return 'base'" },
						},
						DeclaredOnly: {
							$className: "ModuleScript",
							$properties: { Source: "return 'declared'" },
						},
					},
				},
			},
		}),
	});
	const base = path.join(directory, "base.rbxl");
	const output = path.join(directory, "place.rbxl");
	const build = spawnSync("rojo", ["build", "base.project.json", "--output", base], {
		cwd: directory,
		encoding: "utf8",
		timeout: 10_000,
		windowsHide: true,
	});
	assert(build.status === 0, build.error?.message ?? build.stderr);
	return { base, capture: readFileSync(FIXTURE), directory, output };
}

describe("native capture assembly", () => {
	it("should save captured script edits and restore a missing declared script", ({ expect }) => {
		expect.assertions(2);

		const { base, capture, output } = makeAssembly();

		native.assemblePlace(base, capture, SERVICES, output);

		expect(
			native.readModelScriptSources(output, [
				["ServerScriptService", "NativeModelFixture", "App"],
				["ServerScriptService", "NativeModelFixture", "DeclaredOnly"],
			]),
		).toStrictEqual(['return "original app"\n', "return 'declared'"]);
		expect(
			native.readModelStringValues(output, [
				["ServerScriptService", "NativeModelFixture", "Settings"],
			]),
		).toStrictEqual(["keep this property"]);
	});

	it("should reject invalid roots and keep the existing place unchanged", ({ expect }) => {
		expect.assertions(3);

		const { base, capture, directory, output } = makeAssembly();
		copyFileSync(base, output);
		const original = readFileSync(output);

		expect(() => {
			native.assemblePlace(
				base,
				capture,
				JSON.stringify([{ name: "ServerScriptService", roots: [1] }]),
				output,
			);
		}).toThrow(/assemble place.*capture root index is out of range/u);
		expect(readFileSync(output)).toStrictEqual(original);
		expect(readdirSync(directory).toSorted()).toStrictEqual([
			"base.project.json",
			"base.rbxl",
			"place.rbxl",
		]);
	});

	it("should report an unreadable capture without replacing the place", ({ expect }) => {
		expect.assertions(2);

		const { base } = makeAssembly();
		const original = readFileSync(base);

		expect(() => {
			native.assemblePlace(base, new Uint8Array([1, 2, 3]), SERVICES, base);
		}).toThrow(/assemble place/u);
		expect(readFileSync(base)).toStrictEqual(original);
	});
});
