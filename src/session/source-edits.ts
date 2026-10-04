import { type } from "arktype";
import path from "node:path";
import stripJsonComments from "strip-json-comments";

import type { FileSystem } from "../seams/file-system.ts";

/** The newest change to a file the compiler reads. */
export interface SourceEdit {
	/** Its modification time, in milliseconds since the Unix epoch. */
	at: number;
	/** The file, relative to the project. */
	path: string;
}

/** Where the compiler's sources are. */
export interface SourceRoots {
	/** The compiler's arguments: `-p` or `--project` names its tsconfig. */
	args: ReadonlyArray<string>;
	/** The project root. */
	cwd: string;
	/** `rbxts.project`: the tsconfig the build compiles, over `args`. */
	project?: string | undefined;
}

/**
 * How far a file's time may run ahead of the clock and still be an edit:
 * on Windows a file written just now can read a few milliseconds ahead of
 * `Date.now()`.
 */
export const MTIME_SLACK_MS = 1000;

type SourceFileSystem = Pick<FileSystem, "readdirSync" | "readFileSync" | "statSync">;

/** The tsconfig fields that place the sources; the compiler checks the rest. */
const tsconfig = type({
	"compilerOptions?": {
		"outDir?": "string | null",
		"rootDir?": "string | null",
		"rootDirs?": "string[] | null",
	},
	"extends?": "string | string[]",
	"references?": type({ path: "string" }).array(),
});

const tsconfigText = type("string.json.parse").pipe(tsconfig);

/** The tsconfig variable for the directory of the tsconfig that extends. */
// oxlint-disable-next-line no-template-curly-in-string -- tsconfig syntax
const CONFIG_DIR = "${configDir}";

type Tsconfig = typeof tsconfig.infer;

/** The options that place one project's sources, as absolute paths. */
interface SourceOptions {
	outDir?: string | undefined;
	rootDir?: string | undefined;
	rootDirs?: Array<string> | undefined;
}

/** What a scan skips, and the newest edit it found so far. */
interface Scan {
	before: number;
	/** The project root, which edit paths are relative to. */
	cwd: string;
	fileSystem: SourceFileSystem;
	newest: SourceEdit | undefined;
	outDirs: Set<string>;
}

/**
 * Find the newest file under the root directories of the tsconfig the build
 * compiles (`rootDirs`, else `rootDir`, through `extends`) and of each
 * project it references, outside their `outDir`s, `node_modules`, and
 * hidden entries. A tsconfig forge cannot read, or one with no root
 * directory, adds no edit.
 *
 * @param fileSystem - Reads the tsconfigs and the sources.
 * @param roots - The project root, the compiler's arguments, and
 *   `rbxts.project`.
 * @param before - Times more than {@link MTIME_SLACK_MS} later are no edit.
 * @returns The newest edit, if any.
 */
export function newestSourceEdit(
	fileSystem: SourceFileSystem,
	roots: SourceRoots,
	before: number,
): SourceEdit | undefined {
	const scan: Scan = {
		before,
		cwd: roots.cwd,
		fileSystem,
		newest: undefined,
		outDirs: new Set(),
	};
	// Stryker disable next-line ArrayDeclaration: a missing directory adds no
	// edit
	const directories: Array<string> = [];
	collectProject(scan, tsconfigPath(roots), new Set(), directories);
	for (const directory of directories) {
		walk(scan, directory);
	}

	return scan.newest;
}

/**
 * The tsconfig a reference or `-p` names: a file, or a directory's
 * `tsconfig.json`.
 *
 * @param directory - What the name is relative to.
 * @param name - The path in the reference or the flag.
 * @returns The tsconfig's path.
 */
function referencePath(directory: string, name: string): string {
	const resolved = path.resolve(directory, name);
	return resolved.endsWith(".json") ? resolved : path.join(resolved, "tsconfig.json");
}

function tsconfigPath({ args, cwd, project }: SourceRoots): string {
	const flag = args.findIndex((argument) => argument === "-p" || argument === "--project");
	const named = project ?? (flag === -1 ? undefined : args[flag + 1]);
	return named === undefined ? path.join(cwd, "tsconfig.json") : referencePath(cwd, named);
}

function readTsconfig(fileSystem: SourceFileSystem, file: string): Tsconfig | undefined {
	let text: string;
	try {
		text = fileSystem.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}

	const config = tsconfigText(stripJsonComments(text, { trailingCommas: true }));
	return config instanceof type.errors ? undefined : config;
}

/**
 * Resolve a path option of a tsconfig.
 *
 * @param directory - The tsconfig's directory.
 * @param leafDirectory - What `${configDir}` stands for: the directory of
 *   the tsconfig that extends, not of a base.
 * @param value - A path in the tsconfig, which may hold the variable.
 * @returns The absolute path.
 */
function resolveOption(directory: string, leafDirectory: string, value: string): string {
	return path.resolve(
		directory,
		value.replaceAll(CONFIG_DIR, () => leafDirectory),
	);
}

/**
 * The options a tsconfig sets itself; `null` clears one it extends.
 *
 * @param config - The tsconfig.
 * @param directory - Its directory.
 * @param leafDirectory - What `${configDir}` stands for.
 * @returns Only the options it sets, as absolute paths.
 */
function ownOptions(config: Tsconfig, directory: string, leafDirectory: string): SourceOptions {
	const options: SourceOptions = {};
	const { outDir, rootDir, rootDirs } = config.compilerOptions ?? {};
	if (outDir !== undefined) {
		options.outDir =
			outDir === null ? undefined : resolveOption(directory, leafDirectory, outDir);
	}

	if (rootDir !== undefined) {
		options.rootDir =
			rootDir === null ? undefined : resolveOption(directory, leafDirectory, rootDir);
	}

	if (rootDirs !== undefined) {
		options.rootDirs = rootDirs?.map((value) => resolveOption(directory, leafDirectory, value));
	}

	return options;
}

/**
 * The options of a tsconfig over those of each base it extends, in order.
 * A base that is a package, unreadable, or in a cycle adds nothing.
 *
 * @param fileSystem - Reads the bases.
 * @param tsconfigFile - The tsconfig, read, and its path.
 * @param tsconfigFile.config - The parsed tsconfig.
 * @param tsconfigFile.file - Its path: paths in it are relative to its
 *   directory.
 * @param leafDirectory - What `${configDir}` stands for: the directory of
 *   the tsconfig that extends.
 * @param chain - The tsconfigs that extend this one.
 * @returns The options, as absolute paths.
 */
function sourceOptions(
	fileSystem: SourceFileSystem,
	{ config, file }: { config: Tsconfig; file: string },
	leafDirectory: string,
	chain: Set<string>,
): SourceOptions {
	const directory = path.dirname(file);
	const below = new Set([...chain, file]);
	// Stryker disable next-line ArrayDeclaration: a base that is not a path is
	// skipped
	const bases = [config.extends ?? []]
		.flat()
		.filter((base) => base.startsWith(".") || path.isAbsolute(base))
		.map((base) => {
			const baseFile = path.resolve(
				directory,
				base.endsWith(".json") ? base : `${base}.json`,
			);
			const baseConfig = below.has(baseFile) ? undefined : readTsconfig(fileSystem, baseFile);
			return baseConfig === undefined
				? {}
				: sourceOptions(
						fileSystem,
						{ config: baseConfig, file: baseFile },
						leafDirectory,
						below,
					);
		});
	return Object.assign({}, ...bases, ownOptions(config, directory, leafDirectory));
}

/**
 * Add the root directories of a project and of each project it references,
 * and skip their output directories.
 *
 * @param scan - Gets the output directories.
 * @param file - The project's tsconfig.
 * @param seen - The tsconfigs read so far, so a cycle ends.
 * @param directories - Gets the root directories.
 */
function collectProject(
	scan: Scan,
	file: string,
	seen: Set<string>,
	directories: Array<string>,
): void {
	const config = seen.has(file) ? undefined : readTsconfig(scan.fileSystem, file);
	seen.add(file);
	if (config === undefined) {
		return;
	}

	const directory = path.dirname(file);
	const options = sourceOptions(scan.fileSystem, { config, file }, directory, new Set());
	directories.push(
		// Stryker disable next-line ArrayDeclaration: a missing directory adds
		// no edit
		...(options.rootDirs ?? (options.rootDir === undefined ? [] : [options.rootDir])),
	);
	if (options.outDir !== undefined) {
		scan.outDirs.add(options.outDir);
	}

	const references = config.references ?? [];
	for (const reference of references) {
		collectProject(scan, referencePath(directory, reference.path), seen, directories);
	}
}

function isSkipped(name: string): boolean {
	return name === "node_modules" || name.startsWith(".");
}

function visit(scan: Scan, file: string): void {
	let at: number;
	try {
		at = scan.fileSystem.statSync(file).mtimeMs;
	} catch {
		// Removed since its directory was read.
		return;
	}

	if (at <= scan.before + MTIME_SLACK_MS && at > (scan.newest?.at ?? -Infinity)) {
		scan.newest = { at, path: path.relative(scan.cwd, file) };
	}
}

function walk(scan: Scan, directory: string): void {
	let entries: Array<{ isDirectory: () => boolean; name: string }>;
	try {
		entries = scan.fileSystem.readdirSync(directory, { withFileTypes: true });
	} catch {
		// Gone, or not a directory.
		return;
	}

	for (const entry of entries) {
		const file = path.join(directory, entry.name);
		if (isSkipped(entry.name) || scan.outDirs.has(file)) {
			continue;
		}

		if (entry.isDirectory()) {
			walk(scan, file);
		} else {
			visit(scan, file);
		}
	}
}
