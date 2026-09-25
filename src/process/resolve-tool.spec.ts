import path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem, createTestSeams, PROJECT } from "../../test/helpers/seams.ts";
import type { Environment } from "../seams/seams.ts";
import type { ToolLookup } from "./resolve-tool.ts";
import { resolveTool, toolInvocation } from "./resolve-tool.ts";

const TOOLS = path.join(PROJECT, "tools");
const MORE_TOOLS = path.join(PROJECT, "more-tools");

interface LookupOptions {
	environment?: Environment;
	files?: Record<string, string>;
	platform?: NodeJS.Platform;
}

function makeLookup({
	environment = {},
	files = {},
	platform = "linux",
}: LookupOptions = {}): ToolLookup {
	return {
		cwd: PROJECT,
		env: environment,
		fileSystem: createMemoryFileSystem(files).fileSystem,
		host: { ...createTestSeams().host, platform },
	};
}

function projectWith(
	dependency: string,
	manifest: Readonly<Record<string, unknown>>,
	bin = "bin/cli.js",
): Record<string, string> {
	return {
		[`node_modules/${dependency}/${bin}`]: "",
		[`node_modules/${dependency}/package.json`]: JSON.stringify(manifest),
		"package.json": JSON.stringify({ devDependencies: { [dependency]: "1.0.0" } }),
	};
}

describe(resolveTool, () => {
	it("should run a dependency's bin entry with Node", () => {
		expect.assertions(1);

		const lookup = makeLookup({
			files: projectWith("roblox-ts", { bin: { rbxtsc: "out/cli.js" } }, "out/cli.js"),
		});

		expect(resolveTool("rbxtsc", lookup)).toStrictEqual({
			entry: path.join(PROJECT, "node_modules", "roblox-ts", "out", "cli.js"),
			type: "node",
		});
	});

	it("should take a single bin named after the unscoped package", () => {
		expect.assertions(1);

		const lookup = makeLookup({
			files: projectWith("@acme/rojo", { name: "@acme/rojo", bin: "bin/cli.js" }),
		});

		expect(resolveTool("rojo", lookup)).toMatchObject({ type: "node" });
	});

	it.for([
		["a single bin of another name", { name: "darklua", bin: "bin/cli.js" }],
		["a single bin with no package name", { bin: "bin/cli.js" }],
		["a bin map without the command", { bin: { other: "bin/cli.js" } }],
		["no bin", { name: "rojo" }],
		["a bin whose file is missing", { bin: { rojo: "bin/missing.js" } }],
		["a manifest that breaks the schema", { bin: 5 }],
	] as const)("should skip a dependency with %s", ([, manifest]) => {
		expect.assertions(1);

		expect(
			resolveTool("rojo", makeLookup({ files: projectWith("tool", manifest) })),
		).toBeUndefined();
	});

	it("should read dependencies of every kind", () => {
		expect.assertions(1);

		const lookup = makeLookup({
			files: {
				"node_modules/a/a.js": "",
				"node_modules/a/package.json": JSON.stringify({ bin: { a: "a.js" } }),
				"node_modules/b/b.js": "",
				"node_modules/b/package.json": JSON.stringify({ bin: { b: "b.js" } }),
				"node_modules/c/c.js": "",
				"node_modules/c/package.json": JSON.stringify({ bin: { c: "c.js" } }),
				"package.json": JSON.stringify({
					dependencies: { a: "1" },
					devDependencies: { b: "1" },
					optionalDependencies: { c: "1" },
				}),
			},
		});

		expect(["a", "b", "c"].map((name) => resolveTool(name, lookup))).toStrictEqual([
			expect.objectContaining({ type: "node" }),
			expect.objectContaining({ type: "node" }),
			expect.objectContaining({ type: "node" }),
		]);
	});

	it.for([
		["a project manifest that is not JSON", { "package.json": "{" }],
		[
			"a project manifest that breaks the schema",
			{ "package.json": '{ "devDependencies": 1 }' },
		],
		[
			"a dependency that is not installed",
			{ "package.json": '{ "devDependencies": { "x": "1" } }' },
		],
	] as const)("should fall back to PATH with %s", ([, files]) => {
		expect.assertions(1);

		const lookup = makeLookup({
			environment: { PATH: TOOLS },
			files: { ...files, "tools/rojo": "" },
		});

		expect(resolveTool("rojo", lookup)).toStrictEqual({
			file: path.join(TOOLS, "rojo"),
			type: "executable",
		});
	});

	it("should take the first PATH directory that has the command", () => {
		expect.assertions(1);

		const lookup = makeLookup({
			environment: { PATH: `${TOOLS}::${MORE_TOOLS}` },
			files: { "more-tools/rojo": "", "tools/rojo/readme": "" },
		});

		expect(resolveTool("rojo", lookup)).toStrictEqual({
			file: path.join(MORE_TOOLS, "rojo"),
			type: "executable",
		});
	});

	it("should resolve a command given as a path against the project", () => {
		expect.assertions(1);

		const lookup = makeLookup({ files: { "tools/rojo": "" } });

		expect(resolveTool("./tools/rojo", lookup)).toStrictEqual({
			file: path.join(TOOLS, "rojo"),
			type: "executable",
		});
	});

	it("should find nothing without a PATH", () => {
		expect.assertions(1);

		expect(resolveTool("rojo", makeLookup())).toBeUndefined();
	});

	it("should try the Windows .exe under WSL", () => {
		expect.assertions(1);

		const lookup = makeLookup({
			environment: { PATH: TOOLS, WSL_DISTRO_NAME: "Ubuntu" },
			files: { "tools/rojo.exe": "" },
		});

		expect(resolveTool("rojo", lookup)).toStrictEqual({
			file: path.join(TOOLS, "rojo.exe"),
			type: "executable",
		});
	});

	it("should not try a .exe outside WSL", () => {
		expect.assertions(1);

		const lookup = makeLookup({
			environment: { PATH: TOOLS },
			files: { "tools/rojo.exe": "" },
		});

		expect(resolveTool("rojo", lookup)).toBeUndefined();
	});

	it.for([
		["rojo.exe", "executable"],
		["rojo.com", "executable"],
		["rojo.cmd", "batch"],
		["rojo.bat", "batch"],
	] as const)("should find %s on a Windows PATH as %s", ([file, kind]) => {
		expect.assertions(1);

		const lookup = makeLookup({
			environment: { Path: TOOLS },
			files: { [`tools/${file}`]: "" },
			platform: "win32",
		});

		expect(resolveTool("rojo", lookup)).toStrictEqual({
			file: path.join(TOOLS, file),
			type: kind,
		});
	});

	it("should follow PATHEXT order and ignore empty entries", () => {
		expect.assertions(1);

		const lookup = makeLookup({
			environment: { PATH: TOOLS, PATHEXT: ".CMD;;.EXE" },
			files: { "tools/rojo": "", "tools/rojo.cmd": "", "tools/rojo.exe": "" },
			platform: "win32",
		});

		expect(resolveTool("rojo", lookup)).toStrictEqual({
			file: path.join(TOOLS, "rojo.cmd"),
			type: "batch",
		});
	});

	it("should keep an extension a Windows command already has", () => {
		expect.assertions(1);

		const lookup = makeLookup({
			environment: { PATH: TOOLS },
			files: { "tools/rojo.EXE": "", "tools/rojo.EXE.cmd": "" },
			platform: "win32",
		});

		expect(resolveTool("rojo.EXE", lookup)).toStrictEqual({
			file: path.join(TOOLS, "rojo.EXE"),
			type: "executable",
		});
	});
});

describe(toolInvocation, () => {
	const host = { ...createTestSeams().host, execPath: "/usr/bin/node" };

	it("should run a Node tool's entry with the current Node", () => {
		expect.assertions(1);

		expect(
			toolInvocation({ entry: "/p/cli.js", type: "node" }, ["-w"], { env: {}, host }),
		).toStrictEqual({ args: ["/p/cli.js", "-w"], file: "/usr/bin/node" });
	});

	it("should run an executable directly", () => {
		expect.assertions(1);

		expect(
			toolInvocation({ file: "/bin/rojo", type: "executable" }, ["build"], { env: {}, host }),
		).toStrictEqual({ args: ["build"], file: "/bin/rojo" });
	});

	it("should run a batch file through cmd.exe", () => {
		expect.assertions(1);

		expect(
			toolInvocation({ file: "C:\\rojo.cmd", type: "batch" }, ["build"], { env: {}, host }),
		).toStrictEqual({
			args: ["/d", "/s", "/c", '"C:\\rojo.cmd ^^^"build^^^""'],
			file: "cmd.exe",
			verbatimArguments: true,
		});
	});
});
