import assert from "node:assert/strict";

import { ForgeError } from "../errors.ts";
import type { CleanupReport, SessionTarget } from "../native/addon.ts";
import type { FinalReport } from "../reaper/protocol.ts";
import { FORCED_CLEANUP_MS } from "../reaper/reaper-client.ts";
import type { LockSeams } from "./locks.ts";
import { LEASE_POLL_MS } from "./locks.ts";
import type { ForgeFiles, SessionFiles } from "./session-files.ts";
import { listSessions, removeSession, sessionFiles } from "./session-files.ts";

/**
 * How long a new session waits for an old session's workers beyond their
 * graceful stop time (`graceMs + 15 s`).
 */
export const OLD_SESSION_MARGIN_MS = 15_000;
/**
 * How long a barrier waits once every worker should be gone: after a
 * session's reaper exited (the final barrier), and after a forced cleanup.
 * On POSIX a worker that escaped its tree may still be dying.
 */
export const SETTLE_MS = 5000;

/** The final barrier always runs to its bound. */
const NEVER_ABORTS = AbortSignal.any([]);

/** Where a barrier stands. */
export interface Barrier {
	/**
	 * No process of the session is left: its lease is free and no scan finds
	 * one.
	 */
	clear: boolean;
	/** The processes of the session still alive; empty once clear. */
	pids: Array<number>;
}

/** One forced cleanup of an old session. */
export interface ForcedCleanup extends CleanupReport {
	sessionId: string;
}

/** How the startup barrier treats old sessions. */
export interface ClearOptions {
	/** How long to wait for each old session. */
	boundMs: number;
	/** `--force`: kill what outlives the bound, then wait again. */
	force: boolean;
	/** Ends the wait early; the old directories stay. */
	signal: AbortSignal;
}

/**
 * What the native scan and cleanup read of one session.
 *
 * @param files - The session's files.
 * @returns Its id, lease, and reaper record.
 */
export function targetOf(files: SessionFiles): SessionTarget {
	return { leasePath: files.lease, recordPath: files.record, sessionId: files.sessionId };
}

/**
 * The barrier of one session: wait until its lease is free and
 * a scan finds none of its processes (marker or lease holders on POSIX,
 * its jobs on Windows, its reaper). On POSIX every worker inherits the
 * lease, and a worker that closed it still carries the marker.
 *
 * @param seams - The clock and native addon.
 * @param files - The session's files.
 * @param boundMs - How long to wait.
 * @param signal - Ends the wait early.
 * @returns Where the barrier stands at the end: the surviving PIDs when
 *   the bound passed; `undefined` when `signal` aborted first.
 */
export async function waitForBarrierAsync(
	seams: Pick<LockSeams, "clock" | "native">,
	files: SessionFiles,
	boundMs: number,
	signal: AbortSignal,
): Promise<Barrier | undefined> {
	const target = targetOf(files);
	const deadline = seams.clock.now() + boundMs;
	for (;;) {
		if (isClear(seams, target)) {
			return { clear: true, pids: [] };
		}

		if (seams.clock.now() >= deadline) {
			return { clear: false, pids: pidsOf(seams, target) };
		}

		try {
			await seams.clock.sleep(LEASE_POLL_MS, signal);
		} catch {
			// Aborted: the caller is stopping.
			return undefined;
		}
	}
}

/**
 * The startup barrier: delete every older session's directory
 * once its barrier is clear, so a new session never overlaps an old
 * session's workers. With `force`, an old session that outlives the bound
 * is cleaned up (see `forceCleanup` of the addon) and waited for again.
 * Call only while holding the singleton lock.
 *
 * @param seams - The clock, file system, and native addon.
 * @param forge - The project's `.forge` files.
 * @param options - The bound, `--force`, and the abort signal.
 * @returns Every forced cleanup it ran.
 * @rejects {ForgeError} `previous_generation_alive` (with the PIDs) when an
 *   old session is still alive at the bound (with `force`: after its
 *   cleanup); `cleanup_unverifiable` when its cleanup found processes it
 *   could not verify.
 */
export async function clearOldSessionsAsync(
	seams: LockSeams,
	forge: ForgeFiles,
	{ boundMs, force, signal }: ClearOptions,
): Promise<Array<ForcedCleanup>> {
	const cleanups: Array<ForcedCleanup> = [];
	for (const sessionId of listSessions(seams.fileSystem, forge)) {
		const files = sessionFiles(forge, sessionId);
		const barrier = await waitForBarrierAsync(seams, files, boundMs, signal);
		if (barrier === undefined) {
			return cleanups;
		}

		if (!barrier.clear) {
			if (!force) {
				throw stillAlive(sessionId, files.directory, barrier.pids);
			}

			const cleanup = await forceAsync(seams, files, signal);
			if (cleanup === undefined) {
				return cleanups;
			}

			cleanups.push(cleanup);
		}

		removeSession(seams.fileSystem, forge, sessionId);
	}

	return cleanups;
}

/**
 * The final barrier of a session whose reaper has exited: the
 * session's files go once its barrier is clear and every tree was reported
 * empty; otherwise they stay, so the next session's barrier waits. Call
 * only while holding the singleton lock.
 *
 * @param seams - The clock, file system, and native addon.
 * @param forge - The project's `.forge` files.
 * @param files - The session's files.
 * @param reports - Every worker's report.
 * @rejects {ForgeError} `cleanup_in_progress` when a process of the session
 *   outlived the wait.
 */
export async function finalBarrierAsync(
	seams: LockSeams,
	forge: ForgeFiles,
	files: SessionFiles,
	reports: ReadonlyArray<FinalReport>,
): Promise<void> {
	const survivors = survivorsOf(reports);
	const barrier = await waitForBarrierAsync(seams, files, SETTLE_MS, NEVER_ABORTS);
	// The final barrier never aborts.
	assert(barrier !== undefined);
	if (!barrier.clear || survivors.length > 0) {
		const names = survivors.length > 0 ? survivors.join(", ") : "the session";
		const { pids } = barrier;
		const named = pids.length > 0 ? ` (PIDs ${pids.join(", ")})` : "";
		throw new ForgeError(
			"cleanup_in_progress",
			`Processes of ${names} were still alive when forge stopped waiting${named}.`,
			{
				details: { pids, reports, sessionId: files.sessionId },
				hint: "Check for them, and stop them by hand.",
			},
		);
	}

	removeSession(seams.fileSystem, forge, files.sessionId);
}

function pidsOf(seams: Pick<LockSeams, "native">, target: SessionTarget): Array<number> {
	return seams
		.native()
		.scanSession(target)
		.map(({ pid }) => pid);
}

/**
 * Whether the barrier is clear now: the lease is free and the scan finds
 * no process of the session. The probe never creates the lease, so it
 * never races the delete of the session's directory (`down` probes
 * without the singleton lock).
 *
 * @param seams - The native addon.
 * @param target - The session.
 * @returns Whether it is clear.
 */
function isClear(seams: Pick<LockSeams, "native">, target: SessionTarget): boolean {
	return seams.native().isLockFree(target.leasePath) && pidsOf(seams, target).length === 0;
}

function stillAlive(sessionId: string, directory: string, pids: Array<number>): ForgeError {
	const named = pids.length > 0 ? ` (PIDs ${pids.join(", ")})` : "";
	return new ForgeError(
		"previous_generation_alive",
		`Processes of an earlier session are still alive${named}.`,
		{
			details: { pids, sessionId },
			hint: `Wait for them to exit, or run again with --force to kill them. Their session files are in ${directory}.`,
		},
	);
}

/**
 * `--force` for one old session: kill what is left of it, then wait for
 * its barrier once more.
 *
 * @param seams - The clock and native addon.
 * @param files - The old session's files.
 * @param signal - Ends the wait early.
 * @returns The cleanup, once the barrier is clear; `undefined` when
 *   `signal` aborted first.
 * @rejects {ForgeError} `cleanup_unverifiable` when it found processes it
 *   could not verify (it killed none of them); `previous_generation_alive`
 *   when processes survived it.
 */
async function forceAsync(
	seams: Pick<LockSeams, "clock" | "native">,
	files: SessionFiles,
	signal: AbortSignal,
): Promise<ForcedCleanup | undefined> {
	const report = await seams.native().forceCleanup(targetOf(files), FORCED_CLEANUP_MS);
	const cleanup = { ...report, sessionId: files.sessionId };
	if (report.unverifiable.length > 0) {
		throw new ForgeError(
			"cleanup_unverifiable",
			`Processes of an earlier session could not be verified, so they were not killed (PIDs ${report.unverifiable.join(", ")}).`,
			{
				details: { cleanup, pids: report.unverifiable, sessionId: files.sessionId },
				hint: `Check them, and stop them by hand. Their session files are in ${files.directory}.`,
			},
		);
	}

	const barrier = await waitForBarrierAsync(seams, files, SETTLE_MS, signal);
	if (barrier === undefined) {
		return undefined;
	}

	if (!barrier.clear) {
		throw stillAlive(files.sessionId, files.directory, barrier.pids);
	}

	return cleanup;
}

function survivorsOf(reports: ReadonlyArray<FinalReport>): Array<string> {
	return reports.filter(({ report }) => report.incomplete).map(({ id }) => id);
}
