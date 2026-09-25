import nodeFs from "node:fs";

/**
 * The file system calls forge makes. Unit tests pass a memfs volume
 * (`test/helpers/memory-file-system.ts`) and assert on its state. Widen the
 * member list when a caller needs another call; keep it a `Pick` of `node:fs`
 * so the real module is the default with no adapter.
 */
export type FileSystem = Pick<
	typeof nodeFs,
	| "existsSync"
	| "mkdirSync"
	| "readdirSync"
	| "readFileSync"
	| "renameSync"
	| "rmSync"
	| "statSync"
	| "writeFileSync"
>;

export const nodeFileSystem: FileSystem = nodeFs;
