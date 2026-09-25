import type { Clock } from "../seams/clock.ts";
import type { FileSystem } from "../seams/file-system.ts";

/** What a file watch polls with. */
export interface WatchOptions {
	clock: Clock;
	fileSystem: FileSystem;
	/** Time between two looks at the file. */
	intervalMs: number;
	/** Ends the watch. */
	signal: AbortSignal;
}

/**
 * Wait until Studio closes a place: its lock file appears, then goes away.
 *
 * @param options - The clock, file system, interval, and end signal.
 * @param lockPath - The place's lock file.
 * @param onOpen - Called once, when the lock file first appears.
 * @returns `true` once Studio closed the place; `false` when the watch
 *   ended first.
 */
export async function waitForStudioCloseAsync(
	options: WatchOptions,
	lockPath: string,
	onOpen: () => void,
): Promise<boolean> {
	const { fileSystem } = options;
	if (!(await pollAsync(options, () => fileSystem.existsSync(lockPath)))) {
		return false;
	}

	onOpen();
	return pollAsync(options, () => !fileSystem.existsSync(lockPath));
}

/**
 * Call `onSave` each time a file is written (its modification time or size
 * changes), until the watch ends. The file as it is now is the start.
 *
 * @param options - The clock, file system, interval, and end signal.
 * @param file - The file to watch, such as the place Studio saves.
 * @param onSave - Called once per change seen.
 */
export async function watchSavesAsync(
	options: WatchOptions,
	file: string,
	onSave: () => void,
): Promise<void> {
	const { fileSystem } = options;
	let version = versionOf(fileSystem, file);
	await pollAsync(options, () => {
		const next = versionOf(fileSystem, file);
		if (next !== version) {
			version = next;
			onSave();
		}

		return false;
	});
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
