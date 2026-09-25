import { Buffer } from "node:buffer";
import path from "node:path";

import type { FileSystem } from "../seams/file-system.ts";

/** How big a log grows before it rotates, and how many old ones stay. */
export interface LogLimits {
	/** Rotated files kept: `<name>.log.1` (newest) to `<name>.log.<keep>`. */
	keep: number;
	/** The size a log may reach before the next line starts a new file. */
	maxBytes: number;
}

/** A log file that takes whole lines. */
export interface LogFile {
	/** The log's path. */
	file: string;
	/** Append one line; a newline is added. */
	write: (line: string) => void;
}

/** Each service keeps at most 4 MiB: the log and 3 rotated files. */
const LOG_LIMITS: Readonly<LogLimits> = { keep: 3, maxBytes: 1_048_576 };

/**
 * Where a service writes its full output: `.forge/logs/<name>.log` in the
 * project.
 *
 * @param cwd - The project root.
 * @param name - The service, such as `compile`.
 * @returns The log's absolute path.
 */
export function logFilePath(cwd: string, name: string): string {
	return path.join(cwd, ".forge", "logs", `${name}.log`);
}

/**
 * Open a log for appending, creating its folder. Before a line would take the
 * log past `maxBytes`, the log rotates: `<file>` becomes `<file>.1`, `.1`
 * becomes `.2`, and the oldest beyond `keep` is removed. A line is never
 * split across files.
 *
 * @param fileSystem - Writes the files.
 * @param file - The log's path.
 * @param limits - Size limit and rotated files kept.
 * @returns The open log.
 */
export function openLogFile(
	fileSystem: FileSystem,
	file: string,
	limits: LogLimits = LOG_LIMITS,
): LogFile {
	fileSystem.mkdirSync(path.dirname(file), { recursive: true });
	let size = fileSystem.existsSync(file) ? fileSystem.statSync(file).size : 0;

	return {
		file,
		write: (line) => {
			const text = `${line}\n`;
			const bytes = Buffer.byteLength(text);
			if (size > 0 && size + bytes > limits.maxBytes) {
				rotate(fileSystem, file, limits.keep);
				size = 0;
			}

			fileSystem.writeFileSync(file, text, { flag: "a" });
			size += bytes;
		},
	};
}

/**
 * Shift every rotated file up one place and make the log the newest. Each
 * rename replaces its target, so the oldest file is overwritten, not kept.
 *
 * @param fileSystem - Renames the files.
 * @param file - The log's path.
 * @param keep - Rotated files kept.
 */
function rotate(fileSystem: FileSystem, file: string, keep: number): void {
	for (let index = keep - 1; index >= 1; index--) {
		const from = `${file}.${index}`;
		if (fileSystem.existsSync(from)) {
			fileSystem.renameSync(from, `${file}.${index + 1}`);
		}
	}

	fileSystem.renameSync(file, `${file}.1`);
}
