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

export const nodeFileSystem: FileSystem = {
	...nodeFs,
	watch: (directory) => nodeFs.watch(nodeFs.realpathSync.native(directory)),
};
