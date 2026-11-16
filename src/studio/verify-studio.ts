import assert from "node:assert/strict";

import { ForgeError } from "../errors.ts";
import { startTimeToEpochMs } from "../native/start-time.ts";
import type { PinnedStudio } from "../seams/studio-host.ts";
import type { StudioSeams } from "./close-studio.ts";
import type { LocatedStudio, StudioProcess } from "./launcher.ts";
import { studioProcessAsync } from "./launcher.ts";
import type { StudioLock } from "./lock-file.ts";
import {
	isLockHost,
	isMissingFile,
	isStudioExecutable,
	parseStudioLock,
	readLockFile,
	studioLockPath,
} from "./lock-file.ts";

/**
 * How much later than the lock file's modification time Studio's start time
 * may be. Studio starts before it writes the lock file, but file systems
 * round modification times (FAT to 2 s) and Linux start times are 10 ms
 * ticks since a boot time that drifts with the wall clock.
 */
export const STUDIO_START_SLACK_MS = 2000;

const NOTHING_KILLED = "Nothing was killed.";
const STALE_HINT =
	"The lock file is stale. Delete it if Roblox Studio does not have the place open.";

/** The Studio process a lock file names, once verified. */
type StudioCheck =
	| { pinned: PinnedStudio; status: "studio" }
	| { status: "closed" }
	| { status: "exited" };

const EXITED: StudioCheck = { status: "exited" };

/**
 * Parse a lock file and check that this computer wrote it.
 *
 * @param seams - This computer.
 * @param text - The lock file's content.
 * @param lockPath - The lock file, for messages.
 * @returns The PID and computer the lock file names.
 * @rejects {ForgeError} `identity_mismatch` when it names no PID, or no
 *   computer or another one.
 */
export async function readStudioLockAsync(
	seams: StudioSeams,
	text: string,
	lockPath: string,
): Promise<StudioLock> {
	const lock = parseStudioLock(text);
	if (lock === undefined) {
		throw new ForgeError(
			"identity_mismatch",
			`${lockPath} names no process. ${NOTHING_KILLED}`,
		);
	}

	checkHost(lock.host, await seams.studioHost.hostnameAsync(), lockPath);
	return lock;
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
 * @rejects {ForgeError} `identity_mismatch` when the process is not Studio,
 *   started after the lock file was written, or the OS refuses the check.
 */
export async function checkStudioAsync(
	seams: StudioSeams,
	pid: number,
	lockPath: string,
): Promise<StudioCheck> {
	const pinned = await queryProcessAsync(pid, async () => seams.studioHost.pinProcessAsync(pid));
	if (pinned === null) {
		return EXITED;
	}

	const executable = await queryProcessAsync(pid, async () => pinned.executablePathAsync());
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

	await checkStartTimeAsync(pinned, seams, { lockPath, lockWrittenMs });
	return { pinned, status: "studio" };
}

/**
 * The Studio that has a place open, verified as closing a place
 * verifies the one its lock file names: a lock file this computer wrote,
 * naming the Studio executable, which started before the lock file.
 *
 * @param seams - The clock, file system, OS, and native addon.
 * @param place - The absolute path of the place file.
 * @returns The Studio; `undefined` when the place has no lock file, or one
 *   that names no verified Studio.
 * @rejects {ForgeError} `native_missing`.
 */
export async function findPlaceStudioAsync(
	seams: StudioSeams,
	place: string,
): Promise<LocatedStudio | undefined> {
	const lockPath = studioLockPath(place);
	const text = readLockFile(seams.fileSystem, lockPath);
	if (text === undefined) {
		return undefined;
	}

	try {
		const { pid } = await readStudioLockAsync(seams, text, lockPath);
		const check = await checkStudioAsync(seams, pid, lockPath);
		return check.status === "studio" ? await studioProcessAsync(check.pinned) : undefined;
	} catch (err) {
		if (err instanceof ForgeError && err.code === "identity_mismatch") {
			return undefined;
		}

		throw err;
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
 * @rejects {ForgeError} `identity_mismatch` when the lock file names another
 *   process or computer, or the OS refuses the check.
 */
export async function checkOwnAsync(
	seams: StudioSeams,
	process: StudioProcess | undefined,
	lockPath: string,
): Promise<PinnedStudio | undefined> {
	if (process === undefined) {
		return undefined;
	}

	const { pid, startTime } = process;
	const pinned = await queryProcessAsync(pid, async () => seams.studioHost.pinProcessAsync(pid));
	if (pinned?.startTime !== startTime) {
		return undefined;
	}

	const text = readLockFile(seams.fileSystem, lockPath);
	const lock = text === undefined ? undefined : await readStudioLockAsync(seams, text, lockPath);
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
 * Run one addon query about a process, turning an OS refusal into
 * `identity_mismatch`: a process forge cannot check is never killed.
 *
 * @template T - What the query returns.
 * @param pid - The PID, for the message.
 * @param query - The addon call.
 * @returns What the call returned.
 * @rejects {ForgeError} `identity_mismatch` when the call throws.
 */
async function queryProcessAsync<T>(pid: number, query: () => Promise<T>): Promise<T> {
	try {
		return await query();
	} catch (err) {
		// The addon throws only `Error`s (`reaper/src/lib.rs`).
		assert(err instanceof Error);
		if (err instanceof ForgeError) {
			throw err;
		}

		throw new ForgeError(
			"identity_mismatch",
			`Could not verify PID ${pid}: ${err.message} ${NOTHING_KILLED}`,
			{ cause: err },
		);
	}
}

/**
 * Check that Studio started before its lock file was written. A Studio that
 * started later reused the PID of the Studio that wrote it.
 *
 * @param pinned - The pinned Studio process.
 * @param seams - The Studio OS and host boot time.
 * @param lock - The lock file and its modification time.
 * @param lock.lockPath - The lock file, for messages.
 * @param lock.lockWrittenMs - When it was last written, in milliseconds since
 *   the Unix epoch.
 * @rejects {ForgeError} `identity_mismatch` when it started later, or forge
 *   cannot read start times on this OS.
 */
async function checkStartTimeAsync(
	pinned: PinnedStudio,
	seams: StudioSeams,
	{ lockPath, lockWrittenMs }: { lockPath: string; lockWrittenMs: number },
): Promise<void> {
	const { host } = seams;
	const platform = await seams.studioHost.platformAsync();
	const startedMs = startTimeToEpochMs(pinned.startTime, platform, host.bootTimeMs());
	if (startedMs === undefined) {
		throw new ForgeError(
			"identity_mismatch",
			`Could not verify PID ${pinned.pid}: forge cannot read process start times on ${platform}. ${NOTHING_KILLED}`,
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
