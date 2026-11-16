import type { AutoRecoveryMode } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import { isHelperChannelLoss } from "../native/helper-client.ts";
import { startTimeToEpochMs } from "../native/start-time.ts";
import type { Environment, Seams } from "../seams/seams.ts";
import type { PinnedStudio } from "../seams/studio-host.ts";
import type { RecoveryReport } from "./auto-recovery.ts";
import { handleAutoRecoveryAsync } from "./auto-recovery.ts";
import { studioCloseMs } from "./close-timeout.ts";
import type { StudioProcess } from "./launcher.ts";
import { readLockFile, studioLockPath } from "./lock-file.ts";
import { checkOwnAsync, checkStudioAsync, readStudioLockAsync } from "./verify-studio.ts";

export { findPlaceStudioAsync, STUDIO_START_SLACK_MS } from "./verify-studio.ts";

/** How often forge looks at a closing Studio. */
export const STUDIO_CLOSE_POLL_MS = 50;

/** How long forge waits for an ended Studio to exit. */
export const STUDIO_EXIT_TIMEOUT_MS = 10_000;

/**
 * How Studio went:
 *
 * - `exited`: it exited on the close request.
 * - `lock_released`: it closed the place (its lock file went), and forge
 *   ended the process at once instead of waiting for its slow exit.
 * - `dialog`: a modal dialog (such as "Save changes?") blocked it, so forge
 *   ended it at once, without a save.
 * - `timeout`: it did not close within {@link studioCloseMs}, so forge
 *   ended it, without a save.
 * - `no_window`: it had no window to ask, so forge ended it.
 */
export type StudioEnd = "dialog" | "exited" | "lock_released" | "no_window" | "timeout";

/** What closing the Studio of a place did. */
export type StudioStop =
	/**
	 * Studio is gone. `forced`: forge ended it with the place still open,
	 * so unsaved changes are lost; not after `lock_released`, where the
	 * place was closed first. `recovery`: what forge did with the
	 * auto-recovery files of a Studio it killed, also after `lock_released`
	 * (the kill can come before Studio deletes them); `null` when Studio
	 * exited by itself.
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
export type StudioSeams = Pick<Seams, "clock" | "fileSystem" | "host" | "studioHost">;

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
 * save), or after {@link studioCloseMs}. A Studio forge ended cannot
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
	let pinned = await checkOwnAsync(seams, target.process, lockPath);
	if (pinned === undefined) {
		const text = readLockFile(seams.fileSystem, lockPath);
		if (text === undefined) {
			return { status: "not_open" };
		}

		const { pid } = await readStudioLockAsync(seams, text, lockPath);
		const check = await checkStudioAsync(seams, pid, lockPath);
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
 * Kill a verified Studio and wait for it to exit.
 *
 * @param pinned - The pinned Studio process.
 * @rejects {ForgeError} `process_failed` when it does not exit in time or
 *   the kill result is lost without verified exit.
 */
async function killStudioAsync(pinned: PinnedStudio): Promise<void> {
	try {
		await pinned.killAsync();
	} catch (err) {
		if (!isHelperChannelLoss(err)) {
			throw err;
		}

		throw new ForgeError(
			"process_failed",
			"The Studio kill result is unknown; Studio exit is unverified.",
			{ cause: err },
		);
	}

	if (!(await pinned.waitForExitAsync(STUDIO_EXIT_TIMEOUT_MS))) {
		throw new ForgeError(
			"process_failed",
			`Roblox Studio (PID ${pinned.pid}) did not exit within ${STUDIO_EXIT_TIMEOUT_MS} ms.`,
		);
	}
}

async function killedAsync(pinned: PinnedStudio, end: StudioEnd): Promise<Ended> {
	return killStudioAsync(pinned).then(() => {
		return { end, forced: end !== "lock_released", killed: true };
	});
}

/**
 * Ask Studio to close. An OS that refuses the request leaves the kill.
 *
 * @param pinned - The pinned Studio process.
 * @param helper - Whether channel failures must preserve an uncertain result.
 * @returns Whether a close request went out.
 * @rejects An uncertain close without verified exit.
 */
async function askToCloseAsync(pinned: PinnedStudio, helper: boolean): Promise<boolean> {
	try {
		return await pinned.requestCloseAsync();
	} catch (err) {
		if (isHelperChannelLoss(err)) {
			let hasExited = false;
			try {
				hasExited = await pinned.waitForExitAsync(STUDIO_EXIT_TIMEOUT_MS);
			} catch {
				// Missing fresh control proves no exit.
			}

			if (hasExited) {
				// Stryker disable next-line BooleanLiteral: exit is already
				// proved.
				return true;
			}

			throw new ForgeError(
				"process_failed",
				"The Studio close result is unknown; Studio was not killed.",
				{ cause: err },
			);
		}

		if (helper) {
			throw err;
		}

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
async function isBlockedAsync(pinned: PinnedStudio): Promise<boolean> {
	try {
		return await pinned.isBlockedAsync();
	} catch {
		return false;
	}
}

/**
 * End a verified Studio: a close request, then a kill once its lock file
 * goes, a modal dialog blocks it, or {@link studioCloseMs} pass; at once
 * when no request went out.
 *
 * @param seams - The clock, file system, and OS.
 * @param pinned - The pinned Studio process.
 * @param lock - Its place's lock file, and whether it was there before the
 *   close request.
 * @param lock.lockPath - The lock file.
 * @param lock.wasLocked - It was there.
 * @returns How it went.
 * @rejects {ForgeError} `process_failed` when it does not exit in time.
 */
async function endStudioAsync(
	{ clock, fileSystem, studioHost }: StudioSeams,
	pinned: PinnedStudio,
	{ lockPath, wasLocked }: { lockPath: string; wasLocked: boolean },
): Promise<Ended> {
	if (!(await askToCloseAsync(pinned, studioHost.onControl !== undefined))) {
		return (await pinned.isAliveAsync())
			? killedAsync(pinned, "no_window")
			: { end: "exited", forced: false, killed: false };
	}

	const deadline = clock.now() + studioCloseMs(await studioHost.platformAsync());
	for (;;) {
		if (!(await pinned.isAliveAsync())) {
			return { end: "exited", forced: false, killed: false };
		}

		if (wasLocked && !fileSystem.existsSync(lockPath)) {
			return killedAsync(pinned, "lock_released");
		}

		if (await isBlockedAsync(pinned)) {
			return killedAsync(pinned, "dialog");
		}

		if (clock.now() >= deadline) {
			return killedAsync(pinned, "timeout");
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
	pinned: PinnedStudio,
	place: string,
	{ env, mode, recoveryDirectory }: RecoveryOptions,
): Promise<RecoveryReport> {
	const { host } = seams;
	const platform = await seams.studioHost.platformAsync();
	const startedMs = startTimeToEpochMs(pinned.startTime, platform, host.bootTimeMs());
	if (startedMs === undefined) {
		return {
			deleted: [],
			mode,
			moved: [],
			warnings: [`forge cannot read process start times on ${platform}.`],
		};
	}

	return handleAutoRecoveryAsync(seams, {
		directories: await seams.studioHost.autoSaveDirectoriesAsync(env),
		mode,
		place,
		recoveryDirectory,
		startedMs,
	});
}
