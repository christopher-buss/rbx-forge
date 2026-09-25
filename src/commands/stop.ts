import assert from "node:assert/strict";
import path from "node:path";

import { loadProjectConfigAsync } from "../config/load.ts";
import { ForgeError } from "../errors.ts";
import type { PinnedProcess } from "../native/addon.ts";
import { startTimeToEpochMs } from "../native/start-time.ts";
import type { Host } from "../seams/host.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { Seams } from "../seams/seams.ts";
import type { StudioLock } from "../studio/lock-file.ts";
import {
	isLockHost,
	isStudioExecutable,
	parseStudioLock,
	studioLockPath,
} from "../studio/lock-file.ts";
import type { CommandContext, CommandInput } from "./context.ts";

/** How long `forge stop` waits for a killed Studio to exit. */
export const STUDIO_EXIT_TIMEOUT_MS = 10_000;

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
type StudioCheck = { pinned: PinnedProcess; status: "studio" } | { status: "exited" };

const EXITED: StudioCheck = { status: "exited" };

/**
 * `forge stop`: close the Roblox Studio that has this project's place open.
 * The PID in the place's lock file is only a hint: forge acts only on a lock
 * file this computer wrote, pins the process (so a reused PID cannot be hit
 * later), and kills it only when the OS reports the Studio executable for
 * it and it started before the lock file was written.
 *
 * @param context - The run: project directory, config loader, file system,
 *   and native addon.
 * @param input - The config values flags set.
 * @returns Whether a Studio was stopped, its PID, and the place.
 * @rejects {ForgeError} `identity_mismatch` when the lock file names no
 *   process or another computer, or a process that is not Studio, started
 *   after the lock file was written, or cannot be checked;
 *   `process_failed` when Studio does not exit in time; config errors from
 *   `loadProjectConfigAsync`.
 */
export async function runStopAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const { config } = await loadProjectConfigAsync(
		context.cwd,
		context.seams.configLoader,
		input.config,
	);
	const place = path.resolve(context.cwd, config.open.buildOutputPath ?? config.buildOutputPath);
	const lockPath = studioLockPath(place);
	const { fileSystem } = context.seams;

	if (!fileSystem.existsSync(lockPath)) {
		return {
			data: { place, stopped: false },
			summary: `Roblox Studio does not have ${place} open.`,
		};
	}

	const { pid } = readStudioLock(context.seams, lockPath);
	const check = checkStudio(context.seams, pid, lockPath);
	if (check.status === "exited") {
		return {
			data: { pid, place, stopped: false },
			summary: `Roblox Studio is not running: the lock file names PID ${pid}, which has exited.`,
		};
	}

	killStudio(check.pinned);
	// A killed Studio cannot remove its own lock file.
	fileSystem.rmSync(lockPath);
	return {
		data: { pid, place, stopped: true },
		summary: `Stopped Roblox Studio (PID ${pid}) for ${place}.`,
	};
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
 * Read a lock file and check that this computer wrote it.
 *
 * @param seams - The file system and this computer.
 * @param lockPath - The lock file.
 * @returns The PID and computer the lock file names.
 * @throws {ForgeError} `identity_mismatch` when it names no PID, or no
 *   computer or another one.
 */
function readStudioLock(seams: Seams, lockPath: string): StudioLock {
	const lock = parseStudioLock(seams.fileSystem.readFileSync(lockPath, "utf8"));
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
 * Pin the process a lock file names and check that it is the Studio that
 * wrote the lock file.
 *
 * @param seams - The addon, the OS, and the file system.
 * @param pid - The PID from the lock file.
 * @param lockPath - The lock file, for messages.
 * @returns The pinned Studio, or `exited` when no process has the PID.
 * @throws {ForgeError} `identity_mismatch` when the process is not Studio,
 *   started after the lock file was written, or the OS refuses the check.
 */
function checkStudio(seams: Seams, pid: number, lockPath: string): StudioCheck {
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

	checkStartTime(pinned, seams.host, {
		lockPath,
		lockWrittenMs: seams.fileSystem.statSync(lockPath).mtimeMs,
	});
	return { pinned, status: "studio" };
}
