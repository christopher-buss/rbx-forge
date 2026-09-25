import assert from "node:assert/strict";

import type { AutoRecoveryMode } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import type { PinnedProcess } from "../native/addon.ts";
import { startTimeToEpochMs } from "../native/start-time.ts";
import type { Host } from "../seams/host.ts";
import type { Environment, Seams } from "../seams/seams.ts";
import type { RecoveryReport } from "./auto-recovery.ts";
import { autoSaveDirectories, handleAutoRecoveryAsync } from "./auto-recovery.ts";
import type { StudioProcess } from "./launcher.ts";
import type { StudioLock } from "./lock-file.ts";
import { isLockHost, isStudioExecutable, parseStudioLock, studioLockPath } from "./lock-file.ts";

/**
 * How long Studio gets to close its place on the close request when it
 * shows no dialog; forge then ends it, without a save.
 */
export const STUDIO_CLOSE_MS = 15_000;

/** How often forge looks at a closing Studio. */
export const STUDIO_CLOSE_POLL_MS = 50;

/** How long forge waits for an ended Studio to exit. */
export const STUDIO_EXIT_TIMEOUT_MS = 10_000;

/**
 * How much later than the lock file's modification time Studio's start time
 * may be. Studio starts before it writes the lock file, but file systems
 * round modification times (FAT to 2 s) and Linux start times are 10 ms
 * ticks since a boot time that drifts with the wall clock.
 */
export const STUDIO_START_SLACK_MS = 2000;

/**
 * How Studio went:
 *
 * - `exited`: it exited on the close request.
 * - `lock_released`: it closed the place (its lock file went), and forge
 *   ended the process at once instead of waiting for its slow exit.
 * - `dialog`: a modal dialog (such as "Save changes?") blocked it, so forge
 *   ended it at once, without a save.
 * - `timeout`: it did not close within {@link STUDIO_CLOSE_MS}, so forge
 *   ended it, without a save.
 * - `no_window`: it had no window to ask, so forge ended it.
 */
export type StudioEnd = "dialog" | "exited" | "lock_released" | "no_window" | "timeout";

/** What closing the Studio of a place did. */
export type StudioStop =
	/**
	 * Studio is gone. `forced`: forge ended it with the place still open,
	 * so unsaved changes are lost. `recovery`: what forge did with the
	 * auto-recovery files of a Studio it ended; `null` when it ended none.
	 */
	| {
			end: StudioEnd;
			forced: boolean;
			pid: number;
			recovery: null | RecoveryReport;
			status: "stopped";
	  }
	/** Studio closed the place by itself while forge checked it. */
	| { pid: number; status: "closed_first" }
	/** The PID the lock file names has exited: Studio is not running. */
	| { pid: number; status: "exited" }
	/** The place has no lock file: Studio does not have it open. */
	| { status: "not_open" };

/** Which Studio to close. */
export interface StudioTarget {
	/** The absolute path of the place file. */
	place: string;
	/** The Studio forge started with the place, as the session recorded it. */
	process?: StudioProcess | undefined;
}

/** What forge does with the auto-recovery files of a Studio it ends. */
export interface RecoveryOptions {
	/** Holds the AutoSaves folder locations. */
	env: Environment;
	mode: AutoRecoveryMode;
	/** `.forge/recovery` of the project. */
	recoveryDirectory: string;
}

/** The seams that find and close Studio. */
export type StudioSeams = Pick<Seams, "clock" | "fileSystem" | "host" | "native">;

const NOTHING_KILLED = "Nothing was killed.";
const STALE_HINT =
	"The lock file is stale. Delete it if Roblox Studio does not have the place open.";

/** The Studio process a lock file names, once verified. */
type StudioCheck =
	| { pinned: PinnedProcess; status: "studio" }
	| { status: "closed" }
	| { status: "exited" };

const EXITED: StudioCheck = { status: "exited" };

/** How ending a verified Studio went. */
interface Ended {
	end: StudioEnd;
	forced: boolean;
	/** Forge killed the process. */
	killed: boolean;
}

/**
 * Close the Roblox Studio that has a place open.
 *
 * Which Studio: the one forge started (`target.process`), pinned with its
 * recorded start time, when it still runs; the place's lock file must then
 * name it too, when there is one. Else the one the lock file names: forge
 * acts only on a lock file this computer wrote, pins the process (so a
 * reused PID cannot be hit later), and acts on it only when the OS reports
 * the Studio executable for it and it started before the lock file was
 * written.
 *
 * Studio gets a close request first, as a user who closes its window. Then
 * forge looks every {@link STUDIO_CLOSE_POLL_MS} and ends it at once when
 * its lock file goes (the place is closed; this skips Studio's slow exit),
 * or when a modal dialog blocks it (a place fresh from Rojo always asks to
 * save), or after {@link STUDIO_CLOSE_MS}. A Studio forge ended cannot
 * remove its lock file, so forge does; and it handles the auto-recovery
 * files the Studio left (`recovery`).
 *
 * @param seams - The clock, file system, OS, and native addon.
 * @param target - The place, and the Studio forge started, if any.
 * @param recovery - What to do with auto-recovery files.
 * @returns What it did.
 * @rejects {ForgeError} `identity_mismatch` when the lock file names no
 *   process or another computer, or a process that is not Studio, started
 *   after the lock file was written, is not the Studio forge started, or
 *   cannot be checked; `process_failed` when Studio does not exit in time;
 *   `native_missing`.
 */
export async function closeStudioAsync(
	seams: StudioSeams,
	target: StudioTarget,
	recovery: RecoveryOptions,
): Promise<StudioStop> {
	const lockPath = studioLockPath(target.place);
	const own =
		target.process === undefined ? undefined : checkOwn(seams, target.process, lockPath);
	let pinned = own;
	if (pinned === undefined) {
		const text = readLockText(seams, lockPath);
		if (text === undefined) {
			return { status: "not_open" };
		}

		const { pid } = readStudioLock(seams, text, lockPath);
		const check = checkStudio(seams, pid, lockPath);
		if (check.status !== "studio") {
			return { pid, status: check.status === "exited" ? "exited" : "closed_first" };
		}

		({ pinned } = check);
	}

	// Only a lock file there before the request can go: a Studio still
	// opening has none yet.
	const ended = await endStudioAsync(seams, pinned, {
		lockPath,
		wasLocked: seams.fileSystem.existsSync(lockPath),
	});
	// An ended Studio cannot remove its own lock file; one that closed has.
	seams.fileSystem.rmSync(lockPath, { force: true });
	return {
		end: ended.end,
		forced: ended.forced,
		pid: pinned.pid,
		recovery: ended.killed ? await recoverAsync(seams, pinned, target.place, recovery) : null,
		status: "stopped",
	};
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

function killed(pinned: PinnedProcess, end: StudioEnd): Ended {
	killStudio(pinned);
	return { end, forced: end !== "lock_released", killed: true };
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
 * Whether a modal dialog blocks Studio. A failed query counts as none: the
 * time limit still ends Studio.
 *
 * @param pinned - The pinned Studio process.
 * @returns What the addon reports.
 */
function isBlocked(pinned: PinnedProcess): boolean {
	try {
		return pinned.isBlocked();
	} catch {
		return false;
	}
}

/**
 * End a verified Studio: a close request, then a kill once its lock file
 * goes, a modal dialog blocks it, or {@link STUDIO_CLOSE_MS} pass; at once
 * when no request went out.
 *
 * @param seams - The clock and file system.
 * @param pinned - The pinned Studio process.
 * @param lock - Its place's lock file, and whether it was there before the
 *   close request.
 * @param lock.lockPath - The lock file.
 * @param lock.wasLocked - It was there.
 * @returns How it went.
 * @rejects {ForgeError} `process_failed` when it does not exit in time.
 */
async function endStudioAsync(
	{ clock, fileSystem }: StudioSeams,
	pinned: PinnedProcess,
	{ lockPath, wasLocked }: { lockPath: string; wasLocked: boolean },
): Promise<Ended> {
	if (!askToClose(pinned)) {
		return pinned.isAlive()
			? killed(pinned, "no_window")
			: { end: "exited", forced: false, killed: false };
	}

	const deadline = clock.now() + STUDIO_CLOSE_MS;
	for (;;) {
		if (!pinned.isAlive()) {
			return { end: "exited", forced: false, killed: false };
		}

		if (wasLocked && !fileSystem.existsSync(lockPath)) {
			return killed(pinned, "lock_released");
		}

		if (isBlocked(pinned)) {
			return killed(pinned, "dialog");
		}

		if (clock.now() >= deadline) {
			return killed(pinned, "timeout");
		}

		await clock.sleep(STUDIO_CLOSE_POLL_MS);
	}
}

/**
 * Handle the auto-recovery files of a Studio forge ended.
 *
 * @param seams - The clock, file system, and OS.
 * @param pinned - The ended Studio, for its start time.
 * @param place - The place it had open.
 * @param options - The mode, environment, and recovery folder.
 * @returns What it did.
 */
async function recoverAsync(
	seams: StudioSeams,
	pinned: PinnedProcess,
	place: string,
	{ env, mode, recoveryDirectory }: RecoveryOptions,
): Promise<RecoveryReport> {
	const { host } = seams;
	const startedMs = startTimeToEpochMs(pinned.startTime, host.platform, host.bootTimeMs());
	if (startedMs === undefined) {
		return {
			deleted: [],
			mode,
			moved: [],
			warnings: [`forge cannot read process start times on ${host.platform}.`],
		};
	}

	return handleAutoRecoveryAsync(seams, {
		directories: autoSaveDirectories(env, host.platform),
		mode,
		place,
		recoveryDirectory,
		startedMs,
	});
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
 * Pin the Studio forge started, and check the lock file against it.
 *
 * @param seams - The addon, the OS, and the file system.
 * @param process - Its PID and start time, as recorded at the start.
 * @param lockPath - The place's lock file.
 * @returns The pinned Studio; `undefined` when it is gone (its PID has no
 *   process, or one that started at another time).
 * @throws {ForgeError} `identity_mismatch` when the lock file names another
 *   process or computer, or the OS refuses the check.
 */
function checkOwn(
	seams: StudioSeams,
	{ pid, startTime }: StudioProcess,
	lockPath: string,
): PinnedProcess | undefined {
	const native = seams.native();
	const pinned = queryProcess(pid, () => native.pinProcess(pid));
	if (pinned?.startTime !== startTime) {
		return undefined;
	}

	const text = readLockText(seams, lockPath);
	const lock = text === undefined ? undefined : readStudioLock(seams, text, lockPath);
	if (lock !== undefined && lock.pid !== pid) {
		throw new ForgeError(
			"identity_mismatch",
			`${lockPath} names PID ${lock.pid}, not the Roblox Studio forge started (PID ${pid}). ${NOTHING_KILLED}`,
			{ hint: "Close the other Roblox Studio that has the place open by hand." },
		);
	}

	return pinned;
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
