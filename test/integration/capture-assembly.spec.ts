import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { assert, describe, it } from "vitest";

import { readDeclaredTree } from "../../src/capture/declared-tree.ts";
import { nodeFileSystem } from "../../src/seams/file-system.ts";
import { loadRealNative } from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";

const native = loadRealNative();
const FIXTURE = path.join(import.meta.dirname, "../fixtures/models/scripts.rbxm");
const SERVICES = JSON.stringify([{ name: "ServerScriptService", roots: [0] }]);

function makeAssembly(
	extraTree: Record<string, unknown> = {},
	files: Record<string, string> = {},
): {
	base: string;
	capture: Uint8Array;
	declared: string;
	directory: string;
	output: string;
} {
	const directory = makeTemporaryDirectory({
		...files,
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
				...extraTree,
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
	const declared = JSON.stringify(
		readDeclaredTree(nodeFileSystem, path.join(directory, "base.project.json")),
	);
	return { base, capture: readFileSync(FIXTURE), declared, directory, output };
}

describe("native capture assembly", () => {
	it.for([
		{
			name: "a runtime time alias",
			property: { name: "TimeOfDay", value: { String: "13:30:00" } },
		},
		{
			name: "a canonical clock value",
			property: { name: "ClockTime", value: { Float32: 13.5 } },
		},
	])(
		"should sync $name through genuine Rojo and preserve unreadable project properties",
		({ property }, { expect }) => {
			expect.assertions(5);

			const { base, capture, declared, directory, output } = makeAssembly({
				Lighting: {
					$attributes: { Removed: true },
					$className: "Lighting",
					$properties: { ClockTime: 9, Technology: "ShadowMap" },
				},
			});
			native.assemblePlace(
				base,
				capture,
				JSON.stringify([
					{ name: "ServerScriptService", roots: [0] },
					{
						name: "Lighting",
						attributes: [{ name: "Edited", value: { String: "from Studio" } }],
						properties: [property],
						roots: [],
						tags: ["edited"],
						unreadableProperties: ["Technology"],
					},
				]),
				declared,
				output,
			);
			const projectPath = path.join(directory, "base.project.json");
			const syncback = spawnSync(
				"rojo",
				["syncback", projectPath, "--input", output, "--non-interactive"],
				{
					cwd: directory,
					encoding: "utf8",
					timeout: 10_000,
					windowsHide: true,
				},
			);
			assert(syncback.error === undefined);
			assert(syncback.status === 0, syncback.stderr);
			const project: unknown = JSON.parse(readFileSync(projectPath, "utf8"));

			expect(project).toHaveProperty("tree.Lighting.$properties.ClockTime", 13.5);
			expect(project).toHaveProperty("tree.Lighting.$properties.Technology", "ShadowMap");
			expect(project).toHaveProperty("tree.Lighting.$attributes.Edited", "from Studio");
			expect(project).not.toHaveProperty("tree.Lighting.$attributes.Removed");
			expect(project).toHaveProperty("tree.Lighting.$properties.Tags", ["edited"]);
		},
	);

	it("should save captured script edits and restore a missing declared script", ({ expect }) => {
		expect.assertions(2);

		const { base, capture, declared, output } = makeAssembly();

		native.assemblePlace(base, capture, SERVICES, declared, output);

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

		const { base, capture, declared, directory, output } = makeAssembly();
		copyFileSync(base, output);
		const original = readFileSync(output);

		expect(() => {
			native.assemblePlace(
				base,
				capture,
				JSON.stringify([{ name: "ServerScriptService", roots: [1] }]),
				declared,
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

		const { base, declared } = makeAssembly();
		const original = readFileSync(base);

		expect(() => {
			native.assemblePlace(base, new Uint8Array([1, 2, 3]), SERVICES, declared, base);
		}).toThrow(/assemble place/u);
		expect(readFileSync(base)).toStrictEqual(original);
	});

	it("should name an unsupported engine-produced reference attribute and preserve the place", ({
		expect,
	}) => {
		expect.assertions(2);

		const { base, declared, output } = makeAssembly();
		copyFileSync(base, output);
		const original = readFileSync(output);
		const model = readFileSync(
			path.join(import.meta.dirname, "../fixtures/models/reference-attribute.rbxm"),
		);

		expect(() => {
			native.assemblePlace(
				base,
				model,
				JSON.stringify([{ name: "Workspace", roots: [0, 1] }]),
				declared,
				output,
			);
		}).toThrow(/ForgeReferenceAttributeFixture\.Attributes/u);
		expect(readFileSync(output)).toStrictEqual(original);
	});

	it.for([
		{ name: "a directory", files: {}, workspace: { $path: "Workspace" } },
		{
			name: "a nested project",
			files: {
				"workspace.project.json": JSON.stringify({
					name: "World",
					tree: { $path: "Workspace" },
				}),
			},
			workspace: { $path: "workspace.project.json" },
		},
	])(
		"should drop a file-derived model deleted in Studio when Workspace comes from $name",
		({ files, workspace }, { expect }) => {
			expect.assertions(1);

			const bench = path.join("Workspace", "Bench.model.json");
			const { base, capture, declared, directory, output } = makeAssembly(
				{ Workspace: workspace },
				{ ...files, [bench]: '{"className":"Model"}' },
			);
			native.assemblePlace(
				base,
				capture,
				JSON.stringify([
					{ name: "ServerScriptService", roots: [0] },
					{ name: "Workspace", roots: [] },
				]),
				declared,
				output,
			);
			const syncback = spawnSync(
				"rojo",
				["syncback", "base.project.json", "--input", output, "--non-interactive"],
				{ cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true },
			);
			assert(syncback.status === 0, syncback.stderr);

			expect(existsSync(path.join(directory, bench))).toBe(false);
		},
	);
});
