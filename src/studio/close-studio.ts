import assert from "node:assert/strict";

import { ForgeError } from "../errors.ts";
import type { PinnedProcess } from "../native/addon.ts";
import { startTimeToEpochMs } from "../native/start-time.ts";
import type { Host } from "../seams/host.ts";
import type { Seams } from "../seams/seams.ts";
import type { StudioLock } from "./lock-file.ts";
import { isLockHost, isStudioExecutable, parseStudioLock, studioLockPath } from "./lock-file.ts";

/**
 * How long Studio gets to close on the close request. Studio that asks to
 * save changes stays open; forge ends it after this, without a save.
 */
export const STUDIO_CLOSE_MS = 5000;

/** How long forge waits for an ended Studio to exit. */
export const STUDIO_EXIT_TIMEOUT_MS = 10_000;

/**
 * How much later than the lock file's modification time Studio's start time
 * may be. Studio starts before it writes the lock file, but file systems
 * round modification times (FAT to 2 s) and Linux start times are 10 ms
 * ticks since a boot time that drifts with the wall clock.
 */
export const STUDIO_START_SLACK_MS = 2000;

/** What closing the Studio of a place did. */
export type StudioStop =
	/** The PID the lock file names has exited: Studio is not running. */
	| { forced: boolean; pid: number; status: "stopped" }
	/** Studio closed the place by itself while forge checked it. */
	| { pid: number; status: "closed_first" }
	/** The place has no lock file: Studio does not have it open. */
	| { pid: number; status: "exited" }
	/**
	 * Studio is gone. `forced`: it did not close on the close request in
	 * {@link STUDIO_CLOSE_MS}, so forge ended it.
	 */
	| { status: "not_open" };

/** The seams that find and close Studio. */
export type StudioSeams = Pick<Seams, "fileSystem" | "host" | "native">;

const NOTHING_KILLED = "Nothing was killed.";
const STALE_HINT =
	"The lock file is stale. Delete it if Roblox Studio does not have the place open.";

/** The Studio process a lock file names, once verified. */
type StudioCheck =
	| { pinned: PinnedProcess; status: "studio" }
	| { status: "closed" }
	| { status: "exited" };

const EXITED: StudioCheck = { status: "exited" };

/**
 * Close the Roblox Studio that has a place open. The PID in the place's lock
 * file is only a hint: forge acts only on a lock file this computer wrote,
 * pins the process (so a reused PID cannot be hit later), and acts on it
 * only when the OS reports the Studio executable for it and it started
 * before the lock file was written.
 *
 * Studio gets a close request first, as a user who closes its window. When
 * it is still open after {@link STUDIO_CLOSE_MS} (it asks to save changes),
 * or has no window to close, forge ends it: unsaved changes are lost. Then
 * the lock file goes, which an ended Studio cannot remove itself.
 *
 * @param seams - The file system, the OS, and the native addon.
 * @param place - The absolute path of the place file.
 * @returns What it did.
 * @throws {ForgeError} `identity_mismatch` when the lock file names no
 *   process or another computer, or a process that is not Studio, started
 *   after the lock file was written, or cannot be checked;
 *   `process_failed` when Studio does not exit in time; `native_missing`.
 */
export function closeStudio(seams: StudioSeams, place: string): StudioStop {
	const lockPath = studioLockPath(place);
	const text = readLockText(seams, lockPath);
	if (text === undefined) {
		return { status: "not_open" };
	}

	const { pid } = readStudioLock(seams, text, lockPath);
	const check = checkStudio(seams, pid, lockPath);
	if (check.status !== "studio") {
		return { pid, status: check.status === "exited" ? "exited" : "closed_first" };
	}

	const isForced = endStudio(check.pinned);
	// An ended Studio cannot remove its own lock file; one that closed has.
	seams.fileSystem.rmSync(lockPath, { force: true });
	return { forced: isForced, pid, status: "stopped" };
}

/**
 * Whether a file system call failed because the file is gone: Studio
 * deletes its lock file when it closes, at any time.
 *
 * @param err - What the call threw.
 * @returns True for `ENOENT`.
 */
function isMissingFile(err: unknown): boolean {
	return err instanceof Error && Reflect.get(err, "code") === "ENOENT";
}

/**
 * Read a lock file that Studio may delete at any time.
 *
 * @param seams - The file system.
 * @param lockPath - The lock file.
 * @returns Its content, or `undefined` when there is none.
 */
function readLockText(seams: StudioSeams, lockPath: string): string | undefined {
	try {
		return seams.fileSystem.readFileSync(lockPath, "utf8");
	} catch (err) {
		if (isMissingFile(err)) {
			return undefined;
		}

		throw err;
	}
}

/**
 * Check that the lock file was written on this computer: a PID from another
 * computer names an unrelated process here.
 *
 * @param lockHost - The computer the lock file names.
 * @param hostname - This computer's name.
 * @param lockPath - The lock file, for messages.
 * @throws {ForgeError} `identity_mismatch` when it names no computer or
 *   another one.
 */
function checkHost(lockHost: string | undefined, hostname: string, lockPath: string): void {
	if (lockHost === undefined) {
		throw new ForgeError(
			"identity_mismatch",
			`${lockPath} names no computer, so forge cannot tell that it is this one (${hostname}). ${NOTHING_KILLED}`,
		);
	}

	if (!isLockHost(lockHost, hostname)) {
		throw new ForgeError(
			"identity_mismatch",
			`${lockPath} was written on ${lockHost}, not on this computer (${hostname}). ${NOTHING_KILLED}`,
			{ hint: "Stop Roblox Studio on the computer that has the place open." },
		);
	}
}

/**
 * Parse a lock file and check that this computer wrote it.
 *
 * @param seams - This computer.
 * @param text - The lock file's content.
 * @param lockPath - The lock file, for messages.
 * @returns The PID and computer the lock file names.
 * @throws {ForgeError} `identity_mismatch` when it names no PID, or no
 *   computer or another one.
 */
function readStudioLock(seams: StudioSeams, text: string, lockPath: string): StudioLock {
	const lock = parseStudioLock(text);
	if (lock === undefined) {
		throw new ForgeError(
			"identity_mismatch",
			`${lockPath} names no process. ${NOTHING_KILLED}`,
		);
	}

	checkHost(lock.host, seams.host.hostname, lockPath);
	return lock;
}

/**
 * Ask Studio to close. An OS that refuses the request leaves the kill.
 *
 * @param pinned - The pinned Studio process.
 * @returns Whether a close request went out.
 */
function askToClose(pinned: PinnedProcess): boolean {
	try {
		return pinned.requestClose();
	} catch {
		return false;
	}
}

/**
 * Kill a verified Studio and wait for it to exit.
 *
 * @param pinned - The pinned Studio process.
 * @throws {ForgeError} `process_failed` when it does not exit in time.
 */
function killStudio(pinned: PinnedProcess): void {
	pinned.kill();
	if (!pinned.waitForExit(STUDIO_EXIT_TIMEOUT_MS)) {
		throw new ForgeError(
			"process_failed",
			`Roblox Studio (PID ${pinned.pid}) did not exit within ${STUDIO_EXIT_TIMEOUT_MS} ms.`,
		);
	}
}

/**
 * End a verified Studio: a close request, then a kill when it is still open
 * after {@link STUDIO_CLOSE_MS}, or at once when no request went out.
 *
 * @param pinned - The pinned Studio process.
 * @returns Whether forge had to kill it.
 * @throws {ForgeError} `process_failed` when it does not exit in time.
 */
function endStudio(pinned: PinnedProcess): boolean {
	const isAsked = askToClose(pinned);
	if (isAsked ? pinned.waitForExit(STUDIO_CLOSE_MS) : !pinned.isAlive()) {
		return false;
	}

	killStudio(pinned);
	return true;
}

/**
 * Check that Studio started before its lock file was written. A Studio that
 * started later reused the PID of the Studio that wrote it.
 *
 * @param pinned - The pinned Studio process.
 * @param host - The OS, for the start time's unit.
 * @param lock - The lock file and its modification time.
 * @param lock.lockPath - The lock file, for messages.
 * @param lock.lockWrittenMs - When it was last written, in milliseconds since
 *   the Unix epoch.
 * @throws {ForgeError} `identity_mismatch` when it started later, or forge
 *   cannot read start times on this OS.
 */
function checkStartTime(
	pinned: PinnedProcess,
	host: Host,
	{ lockPath, lockWrittenMs }: { lockPath: string; lockWrittenMs: number },
): void {
	const startedMs = startTimeToEpochMs(pinned.startTime, host.platform, host.bootTimeMs());
	if (startedMs === undefined) {
		throw new ForgeError(
			"identity_mismatch",
			`Could not verify PID ${pinned.pid}: forge cannot read process start times on ${host.platform}. ${NOTHING_KILLED}`,
		);
	}

	if (startedMs > lockWrittenMs + STUDIO_START_SLACK_MS) {
		throw new ForgeError(
			"identity_mismatch",
			`${lockPath} names PID ${pinned.pid}, but that Roblox Studio started after the lock file was written, so it reused the PID. ${NOTHING_KILLED}`,
			{ hint: STALE_HINT },
		);
	}
}

/**
 * Run one addon query about a process, turning an OS refusal into
 * `identity_mismatch`: a process forge cannot check is never killed.
 *
 * @template T - What the query returns.
 * @param pid - The PID, for the message.
 * @param query - The addon call.
 * @returns What the call returned.
 * @throws {ForgeError} `identity_mismatch` when the call throws.
 */
function queryProcess<T>(pid: number, query: () => T): T {
	try {
		return query();
	} catch (err) {
		// The addon throws only `Error`s (`reaper/src/lib.rs`).
		assert(err instanceof Error);
		throw new ForgeError(
			"identity_mismatch",
			`Could not verify PID ${pid}: ${err.message} ${NOTHING_KILLED}`,
			{ cause: err },
		);
	}
}

/**
 * When a lock file was last written.
 *
 * @param seams - The file system.
 * @param lockPath - The lock file.
 * @returns Its modification time, in milliseconds since the Unix epoch;
 *   `undefined` once Studio deleted it.
 */
function lockWrittenAt(seams: StudioSeams, lockPath: string): number | undefined {
	try {
		return seams.fileSystem.statSync(lockPath).mtimeMs;
	} catch (err) {
		if (isMissingFile(err)) {
			return undefined;
		}

		throw err;
	}
}

/**
 * Pin the process a lock file names and check that it is the Studio that
 * wrote the lock file.
 *
 * @param seams - The addon, the OS, and the file system.
 * @param pid - The PID from the lock file.
 * @param lockPath - The lock file, for messages.
 * @returns The pinned Studio; `exited` when no process has the PID;
 *   `closed` when Studio deleted the lock file meanwhile.
 * @throws {ForgeError} `identity_mismatch` when the process is not Studio,
 *   started after the lock file was written, or the OS refuses the check.
 */
function checkStudio(seams: StudioSeams, pid: number, lockPath: string): StudioCheck {
	// Load the addon outside `queryProcess`: `native_missing` must not become
	// `identity_mismatch`.
	const native = seams.native();
	const pinned = queryProcess(pid, () => native.pinProcess(pid));
	if (pinned === null) {
		return EXITED;
	}

	const executable = queryProcess(pid, () => pinned.executablePath());
	if (executable === null) {
		return EXITED;
	}

	if (!isStudioExecutable(executable)) {
		throw new ForgeError(
			"identity_mismatch",
			`${lockPath} names PID ${pid}, but that process is ${executable}, not Roblox Studio. ${NOTHING_KILLED}`,
			{ hint: STALE_HINT },
		);
	}

	const lockWrittenMs = lockWrittenAt(seams, lockPath);
	if (lockWrittenMs === undefined) {
		return { status: "closed" };
	}

	checkStartTime(pinned, seams.host, { lockPath, lockWrittenMs });
	return { pinned, status: "studio" };
}
