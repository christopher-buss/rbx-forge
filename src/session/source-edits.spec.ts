import path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import { MTIME_SLACK_MS, newestSourceEdit } from "./source-edits.ts";

const TSCONFIG = JSON.stringify({ compilerOptions: { outDir: "out", rootDir: "src" } });
const NOW = 10_000;
/** The tsconfig variable for the directory of the tsconfig that extends. */
// oxlint-disable-next-line no-template-curly-in-string -- tsconfig syntax
const CONFIG_DIR = "${configDir}";
/** A time past the clock slack after {@link NOW}; memfs keeps whole seconds. */
const FUTURE = NOW + MTIME_SLACK_MS + 1000;

/**
 * A project whose files have the given modification times.
 *
 * @param files - Each file's content and modification time, by path
 *   relative to the project.
 * @returns The file system seam.
 */
function project(
	files: Record<string, readonly [content: string, mtimeMs: number]>,
): ReturnType<typeof createMemoryFileSystem>["fileSystem"] {
	const memory = createMemoryFileSystem(
		Object.fromEntries(Object.entries(files).map(([file, [content]]) => [file, content])),
	);
	for (const [file, [, mtimeMs]] of Object.entries(files)) {
		memory.setModifiedTime(file, mtimeMs);
	}

	return memory.fileSystem;
}

describe(newestSourceEdit, () => {
	it("should find the newest file under the compiler's root directory", () => {
		expect.assertions(1);

		const fileSystem = project({
			"src/a.ts": ["", 1000],
			"src/c.lua": ["", 2000],
			"src/deep/b.ts": ["", 3000],
			"tsconfig.json": [TSCONFIG, 9000],
		});

		expect(newestSourceEdit(fileSystem, { args: [], cwd: PROJECT }, NOW)).toStrictEqual({
			at: 3000,
			path: path.join("src", "deep", "b.ts"),
		});
	});

	it("should skip dependencies, hidden entries, the output directory, and times after the bound", () => {
		expect.assertions(1);

		const fileSystem = project({
			"src/.cache/a.ts": ["", 5000],
			"src/.hidden.ts": ["", 5000],
			"src/a.ts": ["", 1000],
			"src/future.ts": ["", FUTURE],
			"src/node_modules/x/index.ts": ["", 5000],
			"src/out/a.lua": ["", 5000],
			"tsconfig.json": [
				JSON.stringify({ compilerOptions: { outDir: "src/out", rootDir: "src" } }),
				0,
			],
		});

		expect(newestSourceEdit(fileSystem, { args: [], cwd: PROJECT }, NOW)).toStrictEqual({
			at: 1000,
			path: path.join("src", "a.ts"),
		});
	});

	it("should read each of the root directories from a commented tsconfig", () => {
		expect.assertions(1);

		const fileSystem = project({
			"server/a.ts": ["", 1000],
			"shared/b.ts": ["", 2000],
			"tsconfig.json": [
				'{\n\t// roots\n\t"compilerOptions": { "rootDirs": ["server", "shared"], },\n}',
				0,
			],
		});

		expect(newestSourceEdit(fileSystem, { args: [], cwd: PROJECT }, NOW)).toMatchObject({
			at: 2000,
		});
	});

	it.for([
		{ name: "a --project file", args: ["--project", "game/tsconfig.json"] },
		{ name: "a -p directory", args: ["-p", "game"] },
		{ name: "a -p after other arguments", args: ["--verbose", "-p", "game"] },
	])("should read the tsconfig of $name, relative to its directory", ({ args }) => {
		expect.assertions(1);

		const fileSystem = project({
			"game/src/a.ts": ["", 2000],
			"game/tsconfig.json": [TSCONFIG, 0],
			"src/b.ts": ["", 3000],
			"tsconfig.json": [TSCONFIG, 0],
		});

		expect(newestSourceEdit(fileSystem, { args, cwd: PROJECT }, NOW)).toStrictEqual({
			at: 2000,
			path: path.join("game", "src", "a.ts"),
		});
	});

	it("should skip a file removed after its directory was read", () => {
		expect.assertions(1);

		const fileSystem = project({ "src/a.ts": ["", 1000], "tsconfig.json": [TSCONFIG, 0] });
		const removed = {
			...fileSystem,
			statSync: () => {
				throw new Error("ENOENT");
			},
		};

		expect(newestSourceEdit(removed, { args: [], cwd: PROJECT }, NOW)).toBeUndefined();
	});

	it("should count a file whose time is ahead of the bound by no more than the clock slack", () => {
		expect.assertions(1);

		const fileSystem = project({
			"src/a.ts": ["", NOW + MTIME_SLACK_MS],
			"tsconfig.json": [TSCONFIG, 0],
		});

		expect(newestSourceEdit(fileSystem, { args: [], cwd: PROJECT }, NOW)).toMatchObject({
			at: NOW + MTIME_SLACK_MS,
		});
	});

	it("should read the tsconfig that rbxts.project names over the arguments", () => {
		expect.assertions(1);

		const fileSystem = project({
			"game/src/a.ts": ["", 2000],
			"game/tsconfig.json": [TSCONFIG, 0],
			"lib/src/b.ts": ["", 3000],
			"tsconfig.lib.json": [JSON.stringify({ compilerOptions: { rootDir: "lib/src" } }), 0],
		});

		expect(
			newestSourceEdit(
				fileSystem,
				{ args: ["-p", "game"], cwd: PROJECT, project: "tsconfig.lib.json" },
				NOW,
			),
		).toStrictEqual({ at: 3000, path: path.join("lib", "src", "b.ts") });
	});

	it("should take the root and output directories a tsconfig extends, relative to the base", () => {
		expect.assertions(1);

		const fileSystem = project({
			"config/src/a.ts": ["", 1000],
			"config/src/out/b.lua": ["", 5000],
			"config/tsconfig.base.json": [
				JSON.stringify({ compilerOptions: { outDir: "src/out", rootDir: "src" } }),
				0,
			],
			"tsconfig.json": ['{"extends":"./config/tsconfig.base"}', 0],
		});

		expect(newestSourceEdit(fileSystem, { args: [], cwd: PROJECT }, NOW)).toStrictEqual({
			at: 1000,
			path: path.join("config", "src", "a.ts"),
		});
	});

	it("should let a tsconfig override what it extends, from each of several bases", () => {
		expect.assertions(1);

		const fileSystem = project({
			"a.json": [JSON.stringify({ compilerOptions: { rootDir: "one" } }), 0],
			"b.json": [JSON.stringify({ compilerOptions: { outDir: "two/out" } }), 0],
			"one/a.ts": ["", 3000],
			"tsconfig.json": [
				JSON.stringify({
					compilerOptions: { rootDir: "two" },
					extends: ["./a.json", "./b.json"],
				}),
				0,
			],
			"two/b.ts": ["", 2000],
			"two/out/c.lua": ["", 5000],
		});

		expect(newestSourceEdit(fileSystem, { args: [], cwd: PROJECT }, NOW)).toMatchObject({
			at: 2000,
		});
	});

	it("should skip a base that is a package, and one that is missing", () => {
		expect.assertions(1);

		const fileSystem = project({
			"@tsconfig/node.json": [
				JSON.stringify({ compilerOptions: { rootDirs: ["../pkg"] } }),
				0,
			],
			"pkg/a.ts": ["", 3000],
			"src/a.ts": ["", 2000],
			"tsconfig.json": [
				JSON.stringify({
					compilerOptions: { rootDir: "src" },
					extends: ["@tsconfig/node", "./missing.json"],
				}),
				0,
			],
		});

		expect(newestSourceEdit(fileSystem, { args: [], cwd: PROJECT }, NOW)).toMatchObject({
			at: 2000,
		});
	});

	it("should expand configDir to the directory of the tsconfig that extends", () => {
		expect.assertions(1);

		const fileSystem = project({
			"game/src/a.ts": ["", 1000],
			"game/src/out/b.lua": ["", 5000],
			"game/tsconfig.json": ['{"extends":"../tsconfig.base.json"}', 0],
			"tsconfig.base.json": [
				JSON.stringify({
					compilerOptions: {
						outDir: `${CONFIG_DIR}/src/out`,
						rootDir: `${CONFIG_DIR}/src`,
					},
				}),
				0,
			],
		});

		expect(
			newestSourceEdit(fileSystem, { args: ["-p", "game"], cwd: PROJECT }, NOW),
		).toStrictEqual({ at: 1000, path: path.join("game", "src", "a.ts") });
	});

	it("should keep the root directories of a base that the tsconfig does not set", () => {
		expect.assertions(1);

		const fileSystem = project({
			"base.json": [JSON.stringify({ compilerOptions: { rootDirs: ["one", "two"] } }), 0],
			"one/a.ts": ["", 1000],
			"tsconfig.json": ['{"compilerOptions":{"outDir":"out"},"extends":"./base.json"}', 0],
			"two/b.ts": ["", 2000],
		});

		expect(newestSourceEdit(fileSystem, { args: [], cwd: PROJECT }, NOW)).toMatchObject({
			at: 2000,
		});
	});

	it("should end a cycle of tsconfigs that extend each other", () => {
		expect.assertions(1);

		const fileSystem = project({
			"base.json": ['{"extends":"./tsconfig.json"}', 0],
			"src/a.ts": ["", 2000],
			"tsconfig.json": ['{"compilerOptions":{"rootDir":"src"},"extends":"./base.json"}', 0],
		});

		expect(newestSourceEdit(fileSystem, { args: [], cwd: PROJECT }, NOW)).toMatchObject({
			at: 2000,
		});
	});

	it("should let null clear an option a tsconfig extends", () => {
		expect.assertions(1);

		const fileSystem = project({
			"base.json": [
				JSON.stringify({
					compilerOptions: { outDir: "src/out", rootDir: "src", rootDirs: ["src"] },
				}),
				0,
			],
			"lib.json": [JSON.stringify({ compilerOptions: { rootDir: "lib" } }), 0],
			"lib/a.ts": ["", 1000],
			"src/b.ts": ["", 2000],
			"src/out/c.lua": ["", 3000],
			"tsconfig.json": [
				JSON.stringify({
					compilerOptions: { outDir: null, rootDir: null, rootDirs: null },
					extends: "./base.json",
					references: [{ path: "./lib.json" }],
				}),
				0,
			],
		});

		expect(newestSourceEdit(fileSystem, { args: [], cwd: PROJECT }, NOW)).toMatchObject({
			at: 1000,
		});
	});

	it("should follow the references of a tsconfig, as a build of the solution does", () => {
		expect.assertions(1);

		const fileSystem = project({
			"packages/a/src/a.ts": ["", 2000],
			"packages/a/tsconfig.json": [
				JSON.stringify({
					compilerOptions: { outDir: "out", rootDir: "src" },
					references: [
						{ path: "../b/tsconfig.lib.json" },
						{ path: "../../tsconfig.lib.json" },
					],
				}),
				0,
			],
			"packages/b/out/b.lua": ["", 5000],
			"packages/b/src/b.ts": ["", 3000],
			"packages/b/tsconfig.lib.json": [TSCONFIG, 0],
			"src/main.ts": ["", 1000],
			"tools/x.ts": ["", 4000],
			"tsconfig.lib.json": [
				JSON.stringify({
					compilerOptions: { rootDir: "src" },
					references: [{ path: "./packages/a" }],
				}),
				0,
			],
		});

		expect(
			newestSourceEdit(
				fileSystem,
				{ args: [], cwd: PROJECT, project: "tsconfig.lib.json" },
				NOW,
			),
		).toStrictEqual({ at: 3000, path: path.join("packages", "b", "src", "b.ts") });
	});

	it("should read a solution tsconfig with no root directory of its own through its references", () => {
		expect.assertions(1);

		const fileSystem = project({
			"src/a.ts": ["", 2000],
			"tsconfig.json": ['{"files":[],"references":[{"path":"./tsconfig.lib.json"}]}', 0],
			"tsconfig.lib.json": [TSCONFIG, 0],
		});

		expect(newestSourceEdit(fileSystem, { args: [], cwd: PROJECT }, NOW)).toMatchObject({
			at: 2000,
		});
	});

	it("should read the project's tsconfig when the arguments name none", () => {
		expect.assertions(1);

		const fileSystem = project({ "src/a.ts": ["", 2000], "tsconfig.json": [TSCONFIG, 0] });

		expect(
			newestSourceEdit(fileSystem, { args: ["--verbose"], cwd: PROJECT }, NOW),
		).toMatchObject({ at: 2000 });
	});

	it("should keep the first file it finds of two with the same time", () => {
		expect.assertions(1);

		const fileSystem = project({
			"src/a.ts": ["", 2000],
			"src/b.ts": ["", 2000],
			"tsconfig.json": [TSCONFIG, 0],
		});

		expect(newestSourceEdit(fileSystem, { args: [], cwd: PROJECT }, NOW)).toMatchObject({
			path: path.join("src", "a.ts"),
		});
	});

	it.for([
		{ name: "no tsconfig", files: {} },
		{ name: "a tsconfig that is not JSON", files: { "tsconfig.json": ["{", 0] } },
		{ name: "no root directory", files: { "tsconfig.json": ["{}", 0] } },
		{
			name: "a root directory that is not a string",
			files: { "tsconfig.json": ['{"compilerOptions":{"rootDir":3}}', 0] },
		},
		{ name: "a missing root directory", files: { "tsconfig.json": [TSCONFIG, 0] } },
		{ name: "no edit", files: { "src/a.ts": ["", FUTURE], "tsconfig.json": [TSCONFIG, 0] } },
	] as const)("should find no edit with $name", ({ files }) => {
		expect.assertions(1);

		expect(newestSourceEdit(project(files), { args: [], cwd: PROJECT }, NOW)).toBeUndefined();
	});
});
