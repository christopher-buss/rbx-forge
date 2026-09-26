import type { Clock } from "../seams/clock.ts";
import type { FileSystem } from "../seams/file-system.ts";
import { parseStudioLock, readLockFile } from "../studio/lock-file.ts";

/** What a file watch polls with. */
export interface WatchOptions {
	clock: Clock;
	fileSystem: FileSystem;
	/** Time between two looks at the file. */
	intervalMs: number;
	/** Ends the watch. */
	signal: AbortSignal;
}

/** A running save watch. */
export interface SaveWatch {
	/** Look at the file now, between two polls. */
	check: () => void;
	/** Resolves once the watch ended. */
	done: Promise<void>;
}

/** The lock file of a place a session's Studio has open. */
export interface StudioLockWatch {
	/** The place's lock file. */
	path: string;
	/**
	 * The Studio the session recorded: the lock file must name it. With
	 * none, any lock file counts.
	 */
	pid: number | undefined;
}

/**
 * Wait until Studio closes a place: its lock file appears, naming the
 * recorded Studio, then goes away or names another process.
 *
 * @param options - The clock, file system, interval, and end signal.
 * @param lock - The place's lock file, and the Studio it must name.
 * @param onOpen - Called once, when the lock file first names it.
 * @returns `true` once Studio closed the place; `false` when the watch
 *   ended first.
 */
export async function waitForStudioCloseAsync(
	options: WatchOptions,
	lock: StudioLockWatch,
	onOpen: () => void,
): Promise<boolean> {
	const { fileSystem } = options;
	if (!(await pollAsync(options, () => holdsLock(fileSystem, lock)))) {
		return false;
	}

	onOpen();
	return pollAsync(options, () => !holdsLock(fileSystem, lock));
}

/**
 * Call `onSave` each time a file is written (its modification time or size
 * changes), until the watch ends. The file as it is now is the start.
 *
 * @param options - The clock, file system, interval, and end signal.
 * @param file - The file to watch, such as the place Studio saves.
 * @param onSave - Called once per change seen.
 * @returns The watch: a look now, and its end.
 */
export function watchSaves(options: WatchOptions, file: string, onSave: () => void): SaveWatch {
	const { fileSystem } = options;
	let version = versionOf(fileSystem, file);
	function check(): void {
		const next = versionOf(fileSystem, file);
		if (next !== version) {
			version = next;
			onSave();
		}
	}

	return { check, done: watchUntilEndAsync(options, check) };
}

/**
 * Whether the lock file names the recorded Studio now.
 *
 * @param fileSystem - Reads the lock file.
 * @param lock - The lock file, and the Studio it must name.
 * @returns True when it names it, or is there when no Studio was recorded.
 */
function holdsLock(fileSystem: FileSystem, { path, pid }: StudioLockWatch): boolean {
	if (pid === undefined) {
		return fileSystem.existsSync(path);
	}

	const text = readLockFile(fileSystem, path);
	return text !== undefined && parseStudioLock(text)?.pid === pid;
}

/**
 * Look every `intervalMs` until `check` is true or the watch ends. Polling,
 * not `fs.watch`: it behaves the same on every OS and file system.
 *
 * @param options - The clock, interval, and end signal.
 * @param check - Looks once.
 * @returns `true` when `check` was true; `false` when the watch ended first.
 */
async function pollAsync(
	{ clock, intervalMs, signal }: WatchOptions,
	check: () => boolean,
): Promise<boolean> {
	while (!signal.aborted) {
		if (check()) {
			return true;
		}

		try {
			await clock.sleep(intervalMs, signal);
		} catch {
			// The watch ended while it waited.
		}
	}

	return false;
}

/**
 * Look every `intervalMs` until the watch ends.
 *
 * @param options - The clock, interval, and end signal.
 * @param check - Looks once.
 */
async function watchUntilEndAsync(options: WatchOptions, check: () => void): Promise<void> {
	await pollAsync(options, () => {
		check();
		return false;
	});
}

/**
 * What changes when a file is written.
 *
 * @param fileSystem - Reads the file's status.
 * @param file - The place or lock file to look at.
 * @returns Its modification time and size, or `undefined` when it is missing.
 */
function versionOf(fileSystem: FileSystem, file: string): string | undefined {
	if (!fileSystem.existsSync(file)) {
		return undefined;
	}

	const { mtimeMs, size } = fileSystem.statSync(file);
	return `${mtimeMs}:${size}`;
}
