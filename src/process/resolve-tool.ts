import { type } from "arktype";
import path from "node:path";

import type { FileSystem } from "../seams/file-system.ts";
import type { Host } from "../seams/host.ts";
import type { Environment } from "../seams/seams.ts";
import type { Invocation } from "./command-line.ts";
import { batchInvocation } from "./command-line.ts";
import { pathDelimiter, readVariable } from "./environment.ts";

/** How to start a tool forge runs, such as Rojo or the compiler. */
export type Tool =
	/**
	 * A bin of a project dependency: its JS entry, run with the current Node.
	 */
	| { entry: string; type: "node" }
	/**
	 * A Windows batch file (`.cmd`, `.bat`) from `PATH`, run through cmd.exe.
	 */
	| { file: string; type: "batch" }
	/** A native executable from `PATH`. */
	| { file: string; type: "executable" };

/** Where {@link resolveTool} looks. */
export interface ToolLookup {
	/** The project root: its `package.json` and `node_modules`. */
	cwd: string;
	env: Environment;
	fileSystem: FileSystem;
	host: Host;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const HAS_DIRECTORY = /[/\\]/;
const STRING_MAP = "Record<string, string>";
const JSON_TEXT = "string.json.parse";
const WINDOWS_EXECUTABLE = /\.(?:com|exe)$/i;

const projectManifest = type(JSON_TEXT).pipe(
	type({
		"dependencies?": STRING_MAP,
		"devDependencies?": STRING_MAP,
		"optionalDependencies?": STRING_MAP,
	}),
);

const packageManifest = type(JSON_TEXT).pipe(
	type({
		"bin?": `string | ${STRING_MAP}`,
		"name?": "string",
	}),
);

/**
 * Find a tool by command name. A bin of a project dependency wins, and runs
 * as its JS entry with the current Node executable: never through a
 * `node_modules/.bin` shim. Otherwise the tool is looked up on `PATH` (with
 * `PATHEXT` on Windows, and `<name>.exe` from Windows under WSL).
 *
 * @param name - The command, such as `rojo`, or a path to it.
 * @param lookup - The project, environment, file system, and host.
 * @returns The tool, or `undefined` when it is not installed.
 */
export function resolveTool(name: string, lookup: ToolLookup): Tool | undefined {
	return findDependencyBin(name, lookup) ?? findOnPath(name, lookup);
}

/**
 * The executable and arguments that run a tool.
 *
 * @param tool - The resolved tool.
 * @param args - Arguments for the tool.
 * @param lookup - The environment and host.
 * @returns The executable and arguments to spawn.
 */
export function toolInvocation(
	tool: Tool,
	args: ReadonlyArray<string>,
	{ env, host }: Pick<ToolLookup, "env" | "host">,
): Invocation {
	switch (tool.type) {
		case "batch": {
			return batchInvocation(tool.file, args, env);
		}
		case "executable": {
			return { args, file: tool.file };
		}
		case "node": {
			return { args: [tool.entry, ...args], file: host.execPath };
		}
	}
}

/**
 * The bin file a package provides for a command.
 *
 * @param manifest - The package's manifest.
 * @param name - The command.
 * @returns The path relative to the package, or `undefined`.
 */
function binOf(
	manifest: typeof packageManifest.infer | undefined,
	name: string,
): string | undefined {
	if (manifest === undefined) {
		return undefined;
	}

	const { name: packageName, bin } = manifest;
	if (typeof bin === "string") {
		// A single bin is named after the package, without its scope.
		return packageName?.split("/").at(-1) === name ? bin : undefined;
	}

	return bin?.[name];
}

/**
 * Read a manifest that may be missing or broken.
 *
 * @template T - The manifest's shape.
 * @param fileSystem - Reads the file.
 * @param file - The manifest's path.
 * @param schema - Parses the JSON text and checks its shape.
 * @returns The manifest, or `undefined` when it is missing, not JSON, or the
 *   wrong shape.
 */
function readManifest<T>(
	fileSystem: FileSystem,
	file: string,
	schema: (text: string) => T | type.errors,
): T | undefined {
	if (!fileSystem.existsSync(file)) {
		return undefined;
	}

	const parsed = schema(fileSystem.readFileSync(file, "utf8"));
	return parsed instanceof type.errors ? undefined : parsed;
}

function findDependencyBin(name: string, { cwd, fileSystem }: ToolLookup): Tool | undefined {
	const manifest = readManifest(fileSystem, path.join(cwd, "package.json"), projectManifest);
	if (manifest === undefined) {
		return undefined;
	}

	const dependencies = Object.keys({
		...manifest.dependencies,
		...manifest.devDependencies,
		...manifest.optionalDependencies,
	});
	for (const dependency of dependencies) {
		const directory = path.join(cwd, "node_modules", dependency);
		const bin = binOf(
			readManifest(fileSystem, path.join(directory, "package.json"), packageManifest),
			name,
		);
		const entry = bin === undefined ? undefined : path.join(directory, bin);
		if (entry !== undefined && fileSystem.existsSync(entry)) {
			return { entry, type: "node" };
		}
	}

	return undefined;
}

/**
 * The file names a command can have. Windows tries each `PATHEXT` extension
 * unless the name already has one; WSL also tries the Windows `.exe`.
 *
 * @param name - The command.
 * @param environment - Holds `PATHEXT` and `WSL_DISTRO_NAME`.
 * @param platform - The OS.
 * @returns Names to try, in order.
 */
function fileNames(
	name: string,
	environment: Environment,
	platform: NodeJS.Platform,
): Array<string> {
	if (platform === "win32") {
		const extensions = (readVariable(environment, "PATHEXT", platform) ?? DEFAULT_PATHEXT)
			.split(";")
			.filter((extension) => extension !== "")
			.map((extension) => extension.toLowerCase());
		const extension = path.extname(name).toLowerCase();
		return extensions.includes(extension)
			? [name]
			: extensions.map((candidate) => `${name}${candidate}`);
	}

	const isWsl =
		platform === "linux" &&
		readVariable(environment, "WSL_DISTRO_NAME", platform) !== undefined;
	return isWsl ? [name, `${name}.exe`] : [name];
}

/**
 * Where to look for a command: the project root for a path, else each
 * non-empty `PATH` entry. An empty entry does not mean the project root.
 *
 * @param name - The command.
 * @param lookup - The project root, environment, and host.
 * @returns The directories, or `undefined` when there is no `PATH`.
 */
function searchDirectories(
	name: string,
	{ cwd, env, host }: ToolLookup,
): Array<string> | undefined {
	if (HAS_DIRECTORY.test(name)) {
		return [cwd];
	}

	return readVariable(env, "PATH", host.platform)
		?.split(pathDelimiter(host.platform))
		.filter((directory) => directory !== "");
}

function findOnPath(name: string, lookup: ToolLookup): Tool | undefined {
	const { cwd, env, fileSystem, host } = lookup;
	const directories = searchDirectories(name, lookup);
	if (directories === undefined) {
		return undefined;
	}

	for (const directory of directories) {
		for (const candidate of fileNames(name, env, host.platform)) {
			const file = path.resolve(cwd, directory, candidate);
			if (fileSystem.existsSync(file) && fileSystem.statSync(file).isFile()) {
				return host.platform === "win32" && !WINDOWS_EXECUTABLE.test(file)
					? { file, type: "batch" }
					: { file, type: "executable" };
			}
		}
	}

	return undefined;
}
