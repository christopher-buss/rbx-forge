import assert from "node:assert/strict";
import path from "node:path";

import { loadProjectConfigAsync } from "../config/load.ts";
import { ForgeError } from "../errors.ts";
import type { NativeAddon, PinnedProcess } from "../native/addon.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { StudioLock } from "../studio/lock-file.ts";
import { isStudioExecutable, parseStudioLock, studioLockPath } from "../studio/lock-file.ts";
import type { CommandContext, CommandInput } from "./context.ts";

/** How long `forge stop` waits for a killed Studio to exit. */
export const STUDIO_EXIT_TIMEOUT_MS = 10_000;

const NOTHING_KILLED = "Nothing was killed.";

/** The Studio process a lock file names, once verified. */
type StudioCheck = { pinned: PinnedProcess; status: "studio" } | { status: "exited" };

const EXITED: StudioCheck = { status: "exited" };

/**
 * `forge stop`: close the Roblox Studio that has this project's place open.
 * The PID in the place's lock file is only a hint: forge pins the process
 * (so a reused PID cannot be hit later) and kills it only when the OS
 * reports the Studio executable for it.
 *
 * @param context - The run: project directory, config loader, file system,
 *   and native addon.
 * @param input - The config values flags set.
 * @returns Whether a Studio was stopped, its PID, and the place.
 * @rejects {ForgeError} `identity_mismatch` when the lock file names no
 *   process, or a process that is not Studio or cannot be checked;
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
	const { fileSystem, native } = context.seams;

	if (!fileSystem.existsSync(lockPath)) {
		return {
			data: { place, stopped: false },
			summary: `Roblox Studio does not have ${place} open.`,
		};
	}

	const { pid } = readStudioLock(fileSystem.readFileSync(lockPath, "utf8"), lockPath);
	const check = checkStudio(native(), pid, lockPath);
	if (check.status === "exited") {
		return {
			data: { pid, place, stopped: false },
			summary: `Roblox Studio is not running: the lock file names PID ${pid}, which has exited.`,
		};
	}

	killStudio(check.pinned);
	// A killed Studio cannot remove its own lock file.
	fileSystem.rmSync(lockPath, { force: true });
	return {
		data: { pid, place, stopped: true },
		summary: `Stopped Roblox Studio (PID ${pid}) for ${place}.`,
	};
}

/**
 * Parse a lock file's content.
 *
 * @param text - The lock file's content.
 * @param lockPath - The lock file, for the message.
 * @returns The PID the lock file names.
 * @throws {ForgeError} `identity_mismatch` when it names no PID.
 */
function readStudioLock(text: string, lockPath: string): StudioLock {
	const lock = parseStudioLock(text);
	if (lock === undefined) {
		throw new ForgeError(
			"identity_mismatch",
			`${lockPath} names no process. ${NOTHING_KILLED}`,
		);
	}

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
 * Pin the process a lock file names and check that it is Studio.
 *
 * @param native - The addon.
 * @param pid - The PID from the lock file.
 * @param lockPath - The lock file, for messages.
 * @returns The pinned Studio, or `exited` when no process has the PID.
 * @throws {ForgeError} `identity_mismatch` when the process is not Studio or
 *   the OS refuses the check.
 */
function checkStudio(native: NativeAddon, pid: number, lockPath: string): StudioCheck {
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
			{
				hint: "The lock file is stale. Delete it if Roblox Studio does not have the place open.",
			},
		);
	}

	return { pinned, status: "studio" };
}
