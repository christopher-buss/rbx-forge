import path from "node:path";
import { describe, it } from "vitest";

import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import { readDeclaredTree } from "./declared-tree.ts";

function declaredTree(files: Record<string, object | string>) {
	const { fileSystem } = createMemoryFileSystem(
		Object.fromEntries(
			Object.entries(files).map(([name, content]) => {
				return [name, typeof content === "string" ? content : JSON.stringify(content)!];
			}),
		),
	);
	return readDeclaredTree(fileSystem, path.join(PROJECT, "default.project.json"));
}

describe(readDeclaredTree, () => {
	it("declares project nodes but not the content of a plain $path", ({ expect }) => {
		expect.assertions(1);

		expect(
			declaredTree({
				"default.project.json": {
					tree: {
						$className: "DataModel",
						ServerStorage: { Saved: { $className: "Folder", $path: "Saved.rbxm" } },
						Workspace: { $path: "Workspace" },
					},
				},
				"Workspace/Bench.model.json": '{"className":"Model"}',
			}),
		).toStrictEqual({ ServerStorage: { Saved: {} }, Workspace: {} });
	});

	it("declares the tree of a nested project file relative to its own directory", ({ expect }) => {
		expect.assertions(1);

		expect(
			declaredTree({
				"default.project.json": `{
					// The world comes from its own project.
					"tree": { "Workspace": { "$path": "world/workspace.project.jsonc", "Own": {} } },
				}`,
				"world/inner/default.project.json": { tree: { Deep: { $className: "Folder" } } },
				"world/workspace.project.jsonc": {
					tree: {
						Map: { $path: "inner" },
						Own: { Nested: {} },
						Spawn: { $path: "Spawn" },
					},
				},
			}),
		).toStrictEqual({ Workspace: { Map: { Deep: {} }, Own: { Nested: {} }, Spawn: {} } });
	});

	it("stops at a project that includes itself", ({ expect }) => {
		expect.assertions(1);

		expect(
			declaredTree({
				"default.project.json": { tree: { Loop: { $path: "." }, Workspace: {} } },
			}),
		).toStrictEqual({ Loop: {}, Workspace: {} });
	});
});
