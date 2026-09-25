import { describe, expect, it } from "vitest";

import { compileInstanceGlob } from "./instance-glob.ts";

interface GlobCase {
	path: Array<string>;
	pattern: string;
}

describe(compileInstanceGlob, () => {
	it.for<GlobCase>([
		{ path: ["Workspace"], pattern: "Workspace" },
		{ path: ["Workspace", "Map"], pattern: "Workspace/Map" },
		{ path: ["Workspace", "Map"], pattern: "Workspace/*" },
		{ path: ["Workspace", "Map"], pattern: "*/Map" },
		{ path: ["Workspace", "SpawnPoint"], pattern: "Workspace/Spawn*" },
		{ path: ["Workspace", "SpawnPoint"], pattern: "Workspace/*Point" },
		{ path: ["Workspace", "SpawnPoint"], pattern: "Workspace/S*n*t" },
		{ path: ["Workspace", "Map"], pattern: "Workspace/M?p" },
		{ path: ["Workspace", "Map"], pattern: "Workspace/???" },
		{ path: ["Workspace"], pattern: "**" },
		{ path: ["Workspace", "Map", "Tree"], pattern: "**" },
		{ path: ["Workspace", "Map", "Tree"], pattern: "Workspace/**" },
		{ path: ["Workspace"], pattern: "Workspace/**" },
		{ path: ["Workspace", "Map", "Tree"], pattern: "**/Tree" },
		{ path: ["Tree"], pattern: "**/Tree" },
		{ path: ["Workspace", "Map", "Tree"], pattern: "Workspace/**/Tree" },
		{ path: ["Workspace", "Tree"], pattern: "Workspace/**/Tree" },
		{ path: ["A", "node_modules", "B"], pattern: "**/node_modules/**" },
		{ path: ["A", "node_modules"], pattern: "**/node_modules/**" },
		{ path: ["Workspace", ".hidden"], pattern: "Workspace/*" },
		{ path: ["Workspace", ".hidden", "Part"], pattern: "**" },
		{ path: ["Workspace", "a/b"], pattern: "Workspace/*" },
		{ path: ["Workspace", "(x)+[y]{z}|^$.\\"], pattern: "Workspace/(x)+[y]{z}|^$.\\" },
		{ path: ["Workspace", "😀"], pattern: "Workspace/?" },
		{ path: ["Workspace", "line\nbreak"], pattern: "Workspace/line?break" },
		{ path: ["Workspace", "line\nbreak"], pattern: "Workspace/*" },
		{ path: ["Workspace", ""], pattern: "Workspace/*" },
	])("should match $path with $pattern", ({ path, pattern }) => {
		expect.assertions(1);

		expect(compileInstanceGlob(pattern)(path)).toBeTrue();
	});

	it.for<GlobCase>([
		{ path: ["Workspace", "Map"], pattern: "Workspace" },
		{ path: ["Workspace"], pattern: "Workspace/Map" },
		{ path: ["Workspace", "Map", "Tree"], pattern: "Workspace/*" },
		{ path: ["Workspace", "Map"], pattern: "workspace/map" },
		{ path: ["Workspace", "Maps"], pattern: "Workspace/Map" },
		{ path: ["Workspace", "TheMap"], pattern: "Workspace/Map" },
		{ path: ["Workspace", "Map"], pattern: "Workspace/M?" },
		{ path: ["Workspace", "Map"], pattern: "Workspace/????" },
		{ path: ["Workspace", "SpawnPoint"], pattern: "Workspace/Spawn*x" },
		{ path: ["Workspace", "Map", "Trees"], pattern: "**/Tree" },
		{ path: ["Tree", "Leaf"], pattern: "**/Tree" },
		{ path: ["Workspace", "a/b"], pattern: "Workspace/a/b" },
		{ path: ["Workspace", "Mxp"], pattern: "Workspace/M.p" },
		{ path: ["Workspace", "Map"], pattern: "Workspace/[M]ap" },
	])("should not match $path with $pattern", ({ path, pattern }) => {
		expect.assertions(1);

		expect(compileInstanceGlob(pattern)(path)).toBeFalse();
	});
});
