import path from "node:path";

/**
 * Roblox Studio's place lock file. While Studio has a place open it keeps
 * `<place>.lock` next to it. Studio 0.700 on Windows writes, one per line:
 * its PID, its executable name without extension (`RobloxStudioBeta`), the
 * computer name, and a GUID. Only the PID is read; the rest is not a stable
 * format.
 *
 * The PID is only a hint: the Studio that wrote it may be gone and the PID
 * reused. Callers pin the process and check {@link isStudioExecutable}
 * before they act on it.
 */

/** What a Studio lock file names. */
export interface StudioLock {
	/** The PID Studio wrote when it opened the place. */
	pid: number;
}

/**
 * Executable names of Roblox Studio, lower case, without `.exe`: Windows
 * installs `RobloxStudioBeta.exe`; macOS runs
 * `RobloxStudio.app/Contents/MacOS/RobloxStudio`.
 */
const STUDIO_EXECUTABLES: ReadonlySet<string> = new Set(["robloxstudio", "robloxstudiobeta"]);

/** A PID: digits only, no sign, no leading zero, below 2^32. */
const PID = /^[1-9]\d{0,9}$/;
const MAX_PID = 0xff_ff_ff_ff;
/** The first line break and everything after it. */
const AFTER_FIRST_LINE = /\r?\n.*/s;
const EXE_EXTENSION = /\.exe$/i;

/**
 * The lock file Studio keeps for a place.
 *
 * @param placePath - Path of the place file.
 * @returns The path of its lock file.
 */
export function studioLockPath(placePath: string): string {
	return `${placePath}.lock`;
}

/**
 * Read a Studio lock file.
 *
 * @param text - The file's content.
 * @returns The PID it names, or `undefined` when the first line is not a
 *   PID.
 */
export function parseStudioLock(text: string): StudioLock | undefined {
	const first = text.replace(AFTER_FIRST_LINE, "");
	const pid = Number(first);
	return PID.test(first) && pid <= MAX_PID ? { pid } : undefined;
}

/**
 * Whether an executable path is Roblox Studio's. Compares only the file name,
 * without case and without `.exe`, so it works on paths of any OS.
 *
 * @param executablePath - The full path the OS reports for a process.
 * @returns True for a Studio executable.
 */
export function isStudioExecutable(executablePath: string): boolean {
	// `path.win32` splits on both `/` and `\`.
	const name = path.win32.basename(executablePath).replace(EXE_EXTENSION, "");
	return STUDIO_EXECUTABLES.has(name.toLowerCase());
}
