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
}

type SourceFileSystem = Pick<FileSystem, "readdirSync" | "readFileSync" | "statSync">;

/** The tsconfig fields that place the sources; the compiler checks the rest. */
const tsconfig = type({
	"compilerOptions?": {
		"outDir?": "string",
		"rootDir?": "string",
		"rootDirs?": "string[]",
	},
});

/** What a scan skips, and the newest edit it found so far. */
interface Scan {
	before: number;
	fileSystem: SourceFileSystem;
	newest: SourceEdit | undefined;
	outDir: string | undefined;
	roots: SourceRoots;
}

/**
 * Find the newest file under the root directories of the compiler's
 * tsconfig (`rootDirs`, else `rootDir`), outside its `outDir`,
 * `node_modules`, and hidden entries. A tsconfig forge cannot read, or one
 * with no root directory, gives no edit.
 *
 * @param fileSystem - Reads the tsconfig and the sources.
 * @param roots - The project root and the compiler's arguments.
 * @param before - Later times are no edit: a file with a time ahead of the
 *   clock would hold every wait.
 * @returns The newest edit at or before `before`, if any.
 */
export function newestSourceEdit(
	fileSystem: SourceFileSystem,
	roots: SourceRoots,
	before: number,
): SourceEdit | undefined {
	const file = tsconfigPath(roots);
	const options = readCompilerOptions(fileSystem, file);
	const directory = path.dirname(file);
	const names = options?.rootDirs ?? (options?.rootDir === undefined ? [] : [options.rootDir]);
	const scan: Scan = {
		before,
		fileSystem,
		newest: undefined,
		outDir: options?.outDir === undefined ? undefined : path.resolve(directory, options.outDir),
		roots,
	};
	for (const name of names) {
		walk(scan, path.resolve(directory, name));
	}

	return scan.newest;
}

function tsconfigPath({ args, cwd }: SourceRoots): string {
	const flag = args.findIndex((argument) => argument === "-p" || argument === "--project");
	const project = flag === -1 ? undefined : args[flag + 1];
	if (project === undefined) {
		return path.join(cwd, "tsconfig.json");
	}

	const resolved = path.resolve(cwd, project);
	return resolved.endsWith(".json") ? resolved : path.join(resolved, "tsconfig.json");
}

function readCompilerOptions(
	fileSystem: SourceFileSystem,
	file: string,
): typeof tsconfig.infer.compilerOptions {
	let value: unknown;
	try {
		value = JSON.parse(
			stripJsonComments(fileSystem.readFileSync(file, "utf8"), { trailingCommas: true }),
		);
	} catch {
		return undefined;
	}

	const config = tsconfig(value);
	return config instanceof type.errors ? undefined : config.compilerOptions;
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

	if (at <= scan.before && at > (scan.newest?.at ?? -Infinity)) {
		scan.newest = { at, path: path.relative(scan.roots.cwd, file) };
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
		if (isSkipped(entry.name) || file === scan.outDir) {
			continue;
		}

		if (entry.isDirectory()) {
			walk(scan, file);
		} else {
			visit(scan, file);
		}
	}
}
