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
	// The native assembler receives the tree as JSON.
	return JSON.stringify(readDeclaredTree(fileSystem, path.join(PROJECT, "default.project.json")));
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
		).toBe(JSON.stringify({ ServerStorage: { Saved: {} }, Workspace: {} }));
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
		).toBe(
			JSON.stringify({ Workspace: { Map: { Deep: {} }, Own: { Nested: {} }, Spawn: {} } }),
		);
	});

	it("stops at a project that includes itself", ({ expect }) => {
		expect.assertions(1);

		expect(
			declaredTree({
				"default.project.json": { tree: { Loop: { $path: "." }, Workspace: {} } },
			}),
		).toBe(JSON.stringify({ Loop: {}, Workspace: {} }));
	});

	it("declares a nested project once for each node that includes it", ({ expect }) => {
		expect.assertions(1);

		expect(
			declaredTree({
				"default.project.json": {
					tree: {
						ReplicatedStorage: { $path: "shared.project.json" },
						ServerStorage: { $path: "shared.project.json" },
					},
				},
				"shared.project.json": { tree: { Shared: {} } },
			}),
		).toBe(
			JSON.stringify({ ReplicatedStorage: { Shared: {} }, ServerStorage: { Shared: {} } }),
		);
	});

	it("declares the nested project of an optional $path", ({ expect }) => {
		expect.assertions(1);

		expect(
			declaredTree({
				"default.project.json": {
					tree: { Workspace: { $path: { optional: "world.project.json" } } },
				},
				"world.project.json": { tree: { Map: {} } },
			}),
		).toBe(JSON.stringify({ Workspace: { Map: {} } }));
	});

	it("keeps node names that match Object.prototype keys", ({ expect }) => {
		expect.assertions(1);

		expect(
			declaredTree({
				"default.project.json": `{
					"tree": { "Workspace": { "__proto__": { "Inner": {} }, "constructor": {} } }
				}`,
			}),
		).toBe('{"Workspace":{"__proto__":{"Inner":{}},"constructor":{}}}');
	});
});
