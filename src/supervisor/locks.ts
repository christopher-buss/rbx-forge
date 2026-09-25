import { ForgeError } from "../errors.ts";
import type { FileLock, NativeLoader } from "../native/addon.ts";
import type { Clock } from "../seams/clock.ts";
import type { FileSystem } from "../seams/file-system.ts";
import type { ForgeFiles } from "./session-files.ts";
import { listSessions, removeSession, sessionFiles } from "./session-files.ts";

/** How often a wait for a lease tries the lock again. */
export const LEASE_POLL_MS = 100;
/**
 * How long a new session waits for an old session's workers beyond their
 * graceful stop time (spec #28: `graceMs + 15 s`).
 */
export const OLD_SESSION_MARGIN_MS = 15_000;

/** What the lock helpers run with. */
export interface LockSeams {
	clock: Clock;
	fileSystem: Pick<
		FileSystem,
		"existsSync" | "mkdirSync" | "readdirSync" | "readFileSync" | "rmSync"
	>;
	native: NativeLoader;
}

/**
 * Take the project's singleton lock (`.forge/supervisor.lock`) without
 * waiting. The supervisor holds it for its whole life: only the holder
 * creates or deletes session directories, rewrites `current`, or (#43)
 * opens the endpoint. The OS releases it when the supervisor dies.
 *
 * @param seams - The native addon and file system.
 * @param forge - The project's `.forge` files.
 * @returns The held lock.
 * @throws {ForgeError} `session_running` when another supervisor holds it.
 */
export function acquireSingleton(
	seams: Pick<LockSeams, "fileSystem" | "native">,
	forge: ForgeFiles,
): FileLock {
	seams.fileSystem.mkdirSync(forge.directory, { recursive: true });
	const lock = seams.native().tryLockFile(forge.lock, "exclusive");
	if (lock === null) {
		throw new ForgeError("session_running", "A session already runs for this project.", {
			hint: "Stop it first (Ctrl+C in its terminal), then start again.",
		});
	}

	return lock;
}

/**
 * Wait until nothing holds a lease: take it exclusively. On POSIX every
 * worker inherits the lease, so a free lease means the reaper and every
 * worker that kept it are gone.
 *
 * @param seams - The clock and native addon.
 * @param lease - The lease file.
 * @param boundMs - How long to wait.
 * @param signal - Ends the wait early.
 * @returns The lease, held exclusively; `undefined` when the bound passed or
 *   `signal` aborted first.
 */
export async function waitForLeaseAsync(
	seams: Pick<LockSeams, "clock" | "native">,
	lease: string,
	boundMs: number,
	signal: AbortSignal,
): Promise<FileLock | undefined> {
	const deadline = seams.clock.now() + boundMs;
	for (;;) {
		const lock = seams.native().tryLockFile(lease, "exclusive");
		if (lock !== null || seams.clock.now() >= deadline) {
			return lock ?? undefined;
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
 * The startup barrier (spec #28): delete every older session's directory
 * once its lease is free, so a new session never overlaps an old session's
 * workers. Call only while holding the singleton lock.
 *
 * Only the lease is checked here; #42 adds the marker scan and `--force`.
 *
 * @param seams - The clock, file system, and native addon.
 * @param forge - The project's `.forge` files.
 * @param boundMs - How long to wait for each old session.
 * @param signal - Ends the wait early; the old directories stay.
 * @rejects {ForgeError} `previous_generation_alive` when an old session's
 *   lease is still held at the bound.
 */
export async function clearOldSessionsAsync(
	seams: LockSeams,
	forge: ForgeFiles,
	boundMs: number,
	signal: AbortSignal,
): Promise<void> {
	for (const sessionId of listSessions(seams.fileSystem, forge)) {
		const { directory, lease } = sessionFiles(forge, sessionId);
		const lock = await waitForLeaseAsync(seams, lease, boundMs, signal);
		if (signal.aborted) {
			lock?.release();
			return;
		}

		if (lock === undefined) {
			throw new ForgeError(
				"previous_generation_alive",
				`Processes of an earlier session still hold ${lease}.`,
				{
					details: { sessionId },
					hint: `Wait for them to exit, or stop them, then start again. Their session files are in ${directory}.`,
				},
			);
		}

		// Windows cannot delete a file that is open, so release first.
		lock.release();
		removeSession(seams.fileSystem, forge, sessionId);
	}
}
