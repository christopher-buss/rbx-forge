import nodeFs from "node:fs";

/**
 * The file system calls forge makes. Unit tests pass a memfs volume
 * (`test/helpers/seams.ts`) and assert on its state. Widen the
 * member list when a caller needs another call. Directory watches expand
 * short Windows paths before libuv reads them.
 */
export type FileSystem = Pick<
	typeof nodeFs,
	| "closeSync"
	| "copyFileSync"
	| "existsSync"
	| "mkdirSync"
	| "openSync"
	| "readdirSync"
	| "readFileSync"
	| "readSync"
	| "renameSync"
	| "rmSync"
	| "statSync"
	| "writeFileSync"
> & { watch: (directory: string) => nodeFs.FSWatcher };

/** File operations and directory-path resolution used by the Node backend. */
export interface FileSystemBackend {
	fileSystem: Pick<FileSystem, Exclude<keyof FileSystem, "watch">>;
	realpath: (directory: string) => string;
	watch: FileSystem["watch"];
}

/**
 * Expand directory aliases before libuv watches them, including Windows 8.3.
 *
 * @param backend - File operations and native path resolution.
 * @returns The file-system seam.
 */
export function createNodeFileSystem({
	fileSystem,
	realpath,
	watch,
}: FileSystemBackend): FileSystem {
	return { ...fileSystem, watch: (directory) => watch(realpath(directory)) };
}

export const nodeFileSystem: FileSystem = createNodeFileSystem({
	fileSystem: nodeFs,
	realpath: nodeFs.realpathSync.native,
	watch: nodeFs.watch,
});
