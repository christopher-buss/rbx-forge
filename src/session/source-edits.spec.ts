import path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import { newestSourceEdit } from "./source-edits.ts";

const TSCONFIG = JSON.stringify({ compilerOptions: { outDir: "out", rootDir: "src" } });
const NOW = 10_000;

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
			"src/future.ts": ["", NOW + 1],
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

	it.for([
		{ name: "no tsconfig", files: {} },
		{ name: "a tsconfig that is not JSON", files: { "tsconfig.json": ["{", 0] } },
		{ name: "no root directory", files: { "tsconfig.json": ["{}", 0] } },
		{
			name: "a root directory that is not a string",
			files: { "tsconfig.json": ['{"compilerOptions":{"rootDir":3}}', 0] },
		},
		{ name: "a missing root directory", files: { "tsconfig.json": [TSCONFIG, 0] } },
		{ name: "no edit", files: { "src/a.ts": ["", NOW + 1], "tsconfig.json": [TSCONFIG, 0] } },
	] as const)("should find no edit with $name", ({ files }) => {
		expect.assertions(1);

		expect(newestSourceEdit(project(files), { args: [], cwd: PROJECT }, NOW)).toBeUndefined();
	});
});
