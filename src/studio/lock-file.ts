import path from "node:path";

/**
 * Roblox Studio's place lock file. While Studio has a place open it keeps
 * `<place>.lock` next to it. Studio 0.700 on Windows writes, one per line:
 * its PID, its executable name without extension (`RobloxStudioBeta`), the
 * computer name, and a GUID. Only the PID and the computer name are read.
 *
 * The PID is only a hint: the Studio that wrote it may be gone and the PID
 * reused, or the place may sit on a drive another computer shares. Callers
 * check {@link isLockHost}, pin the process, and check
 * {@link isStudioExecutable} and its start time before they act on it.
 */

/** What a Studio lock file names. */
export interface StudioLock {
	/** The computer Studio runs on, or `undefined` when the file names none. */
	host: string | undefined;
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
const LINE_BREAK = /\r?\n/;
/** The first dot of a DNS name and everything after it. */
const AFTER_FIRST_LABEL = /\..*/;
/** The line of the lock file that names the computer. */
const HOST_LINE = 2;
/** Windows NetBIOS computer names stop at this many characters. */
const NETBIOS_NAME_LENGTH = 15;
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
 * @returns The PID and computer it names, or `undefined` when the first line
 *   is not a PID.
 */
export function parseStudioLock(text: string): StudioLock | undefined {
	const first = text.replace(AFTER_FIRST_LINE, "");
	const pid = Number(first);
	const host = text.split(LINE_BREAK, HOST_LINE + 1)[HOST_LINE]?.trim();
	return PID.test(first) && pid <= MAX_PID
		? { host: host === "" ? undefined : host, pid }
		: undefined;
}

/**
 * Whether the computer a lock file names is this one. Compares without case
 * and only the first DNS label, and accepts a Windows NetBIOS name, which
 * stops at 15 characters.
 *
 * @param lockHost - The computer name in the lock file.
 * @param hostname - This computer's name.
 * @returns True when both name this computer.
 */
export function isLockHost(lockHost: string, hostname: string): boolean {
	const ours = firstLabel(hostname);
	const theirs = firstLabel(lockHost);
	return theirs === ours || (theirs.length === NETBIOS_NAME_LENGTH && ours.startsWith(theirs));
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

/**
 * The first DNS label of a computer name, in lower case.
 *
 * @param hostname - A computer name.
 * @returns The part before the first dot.
 */
function firstLabel(hostname: string): string {
	return hostname.replace(AFTER_FIRST_LABEL, "").toLowerCase();
}
