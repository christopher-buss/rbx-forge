import assert from "node:assert/strict";

import { ForgeError } from "../errors.ts";
import { callSessionAsync } from "../ipc/client.ts";
import type { CleanupReport, PinnedProcess } from "../native/addon.ts";
import { FORCED_CLEANUP_MS } from "../reaper/reaper-client.ts";
import type { Seams } from "../seams/seams.ts";
import type { Barrier } from "../supervisor/barrier.ts";
import { SETTLE_MS, targetOf, waitForBarrierAsync } from "../supervisor/barrier.ts";
import type { ForgeFiles, SessionFiles } from "../supervisor/session-files.ts";
import { removeSession } from "../supervisor/session-files.ts";
import type { KnownSession } from "./session.ts";

/** How long `down` waits after its first shutdown request (spec #28). */
export const DOWN_TIMEOUT_MS = 15_000;
/** How long `down` waits after a forced shutdown request (spec #28). */
export const FORCED_SHUTDOWN_MS = 5000;
/** How long `down --force` waits for the supervisor it killed. */
export const KILL_WAIT_MS = 5000;
/** How often `down` looks at the supervisor again. */
export const DOWN_POLL_MS = 100;

/** A barrier wait nothing aborts. */
const NEVER = AbortSignal.any([]);

/** The seams `down` runs with. */
export type DownSeams = Pick<Seams, "clock" | "fileSystem" | "ipc" | "native">;

/** Where a test can hold `down` up: before the barrier, before the delete. */
export type DownPoint = "barrier" | "delete";

/** How `down` stops a session. */
export interface DownOptions {
	/**
	 * `--force`: kill a supervisor that does not stop (through its pinned,
	 * start-time-verified handle), and kill what outlives the barrier.
	 */
	force: boolean;
	/** Test only: waits at each point. */
	pause?: ((point: DownPoint) => Promise<void>) | undefined;
	/** How long to wait for the supervisor, and for the barrier. */
	timeoutMs: number;
}

/**
 * How the target supervisor went:
 *
 * - `gone`: it had exited before `down` asked.
 * - `shutdown`: it stopped on the shutdown request.
 * - `forced_shutdown`: it stopped on the forced shutdown request.
 * - `killed`: `--force` killed it.
 */
export type StoppedBy = "forced_shutdown" | "gone" | "killed" | "shutdown";

/** What `down` did. */
export interface DownReport {
	/** The forced cleanup of processes that outlived the barrier. */
	cleanup?: CleanupReport;
	/** `down` deleted the session's files; else its supervisor had. */
	removed: boolean;
	sessionId: string;
	stoppedBy: StoppedBy;
}

/** The target's supervisor, pinned when it still runs. */
interface Target {
	forge: ForgeFiles;
	/** Its pin; `undefined` when the recorded process is gone. */
	pin: PinnedProcess | undefined;
	session: KnownSession;
}

/**
 * Stop one session and prove it gone (spec #28, `down`). It acts on this
 * session only: requests carry its id, pins its recorded supervisor, and
 * cleans up and deletes only its files. `stopped` needs both:
 *
 * 1. Its supervisor has exited: its pinned process (PID plus start time)
 *    is gone, or the singleton lock is free, which no running supervisor
 *    of this project leaves free.
 * 2. Its barrier is clear: its lease is free and a scan finds none of its
 *    processes.
 *
 * Escalation: IPC `shutdown` (wait `timeoutMs`), IPC `shutdown` with
 * `force` (wait {@link FORCED_SHUTDOWN_MS}), then, with `force` only, kill
 * the supervisor through its pin; and, when the barrier stays blocked, with
 * `force` only, a forced cleanup of the session. Its files are deleted only
 * under the singleton lock.
 *
 * @param seams - The clock, file system, transport, and native addon.
 * @param forge - The project's `.forge` files.
 * @param session - The target, as `.forge/current` named it.
 * @param options - `--force`, the wait, and the test pause.
 * @returns What it did.
 * @rejects {ForgeError} `supervisor_unresponsive` when the supervisor does
 *   not exit; `cleanup_in_progress` when a process of the session outlives
 *   the barrier; `cleanup_unverifiable` when a forced cleanup found
 *   processes it could not verify; `session_replaced` when another session
 *   answers at the endpoint.
 */
export async function stopSessionAsync(
	seams: DownSeams,
	forge: ForgeFiles,
	session: KnownSession,
	options: DownOptions,
): Promise<DownReport> {
	const target: Target = { forge, pin: pinSupervisor(seams, session), session };
	const stoppedBy = await stopSupervisorAsync(seams, target, options);
	await options.pause?.("barrier");
	const cleanup = await clearBarrierAsync(seams, session.files, options);
	await options.pause?.("delete");
	return {
		...(cleanup === undefined ? {} : { cleanup }),
		removed: removeUnderLock(seams, forge, session.files),
		sessionId: session.identity.sessionId,
		stoppedBy,
	};
}

/**
 * Pin the recorded supervisor, if it still runs.
 *
 * @param seams - The native addon.
 * @param session - The identity record.
 * @returns The pin, only when the PID's process has the recorded start
 *   time; a process that reused the PID, or one this user cannot open, is
 *   not the supervisor.
 */
function pinSupervisor(
	seams: Pick<DownSeams, "native">,
	{ identity }: KnownSession,
): PinnedProcess | undefined {
	let pin: null | PinnedProcess;
	try {
		pin = seams.native().pinProcess(identity.pid);
	} catch {
		return undefined;
	}

	return pin?.startTime === identity.processStartTime ? pin : undefined;
}

/**
 * Whether no supervisor of the project holds the singleton lock. Takes it
 * and lets go at once.
 *
 * @param seams - The native addon.
 * @param forge - The project's `.forge` files.
 * @returns Whether the lock was free.
 */
function isLockFree(seams: Pick<DownSeams, "native">, forge: ForgeFiles): boolean {
	const lock = seams.native().tryLockFile(forge.lock, "exclusive");
	lock?.release();
	return lock !== null;
}

/**
 * Condition 1 of {@link stopSessionAsync}: the target's supervisor has
 * exited.
 *
 * @param seams - The native addon.
 * @param target - The pinned supervisor.
 * @returns Whether it has.
 */
function isGone(seams: Pick<DownSeams, "native">, { forge, pin }: Target): boolean {
	return pin?.isAlive() !== true || isLockFree(seams, forge);
}

/**
 * Ask the target to stop once.
 *
 * @param seams - The transport.
 * @param session - The target's endpoint, token, and id.
 * @param force - Ask for a forced shutdown.
 * @returns Whether it accepted; `false` when nothing answered.
 * @rejects {ForgeError} `session_replaced` when another session answers.
 */
async function askAsync(
	seams: Pick<DownSeams, "ipc">,
	{ identity, token }: KnownSession,
	force: boolean,
): Promise<boolean> {
	const parameters = { ...(force ? { force: true } : {}), sessionId: identity.sessionId };
	try {
		await callSessionAsync(seams.ipc, { endpoint: identity.endpoint, token }, "shutdown", {
			params: parameters,
		});
		return true;
	} catch (err) {
		if (err instanceof ForgeError && err.code === "session_replaced") {
			throw err;
		}

		// Not listening yet or any more, or stalled: ask again.
		return false;
	}
}

/**
 * Ask the target to stop until it accepts, and wait until it is gone.
 *
 * @param seams - The clock, transport, and native addon.
 * @param target - The session and its pinned supervisor.
 * @param force - Ask for a forced shutdown.
 * @param waitMs - How long to wait.
 * @returns Whether the supervisor is gone in time.
 * @rejects {ForgeError} `session_replaced`.
 */
async function requestStopAsync(
	seams: DownSeams,
	target: Target,
	force: boolean,
	waitMs: number,
): Promise<boolean> {
	const deadline = seams.clock.now() + waitMs;
	let isAccepted = false;
	for (;;) {
		if (isGone(seams, target)) {
			return true;
		}

		if (seams.clock.now() >= deadline) {
			return false;
		}

		isAccepted ||= await askAsync(seams, target.session, force);
		await seams.clock.sleep(DOWN_POLL_MS);
	}
}

async function waitGoneAsync(seams: DownSeams, target: Target, waitMs: number): Promise<boolean> {
	const deadline = seams.clock.now() + waitMs;
	while (!isGone(seams, target)) {
		if (seams.clock.now() >= deadline) {
			return false;
		}

		await seams.clock.sleep(DOWN_POLL_MS);
	}

	return true;
}

function unresponsive({ session }: Target, force: boolean): ForgeError {
	const { pid, sessionId } = session.identity;
	return new ForgeError(
		"supervisor_unresponsive",
		`The supervisor of session ${sessionId} (PID ${pid}) did not stop.`,
		{
			details: { pid, sessionId },
			hint: force
				? "Check the process, and stop it by hand."
				: 'Run "forge down --force" to kill it.',
		},
	);
}

/**
 * Condition 1 of {@link stopSessionAsync}, with its escalation.
 *
 * @param seams - The clock, transport, and native addon.
 * @param target - The session and its pinned supervisor.
 * @param options - `--force` and the wait.
 * @returns How the supervisor went.
 * @rejects {ForgeError} `supervisor_unresponsive`; `session_replaced`.
 */
async function stopSupervisorAsync(
	seams: DownSeams,
	target: Target,
	options: DownOptions,
): Promise<StoppedBy> {
	if (isGone(seams, target)) {
		return "gone";
	}

	if (await requestStopAsync(seams, target, false, options.timeoutMs)) {
		return "shutdown";
	}

	if (await requestStopAsync(seams, target, true, FORCED_SHUTDOWN_MS)) {
		return "forced_shutdown";
	}

	if (!options.force) {
		throw unresponsive(target, false);
	}

	// Alive, holding the lock, and pinned with its recorded start time.
	target.pin?.kill();
	if (await waitGoneAsync(seams, target, KILL_WAIT_MS)) {
		return "killed";
	}

	throw unresponsive(target, true);
}

function stillAlive(files: SessionFiles, pids: ReadonlyArray<number>): ForgeError {
	const named = pids.length > 0 ? ` (PIDs ${pids.join(", ")})` : "";
	return new ForgeError(
		"cleanup_in_progress",
		`Processes of session ${files.sessionId} are still alive${named}.`,
		{
			details: { pids, sessionId: files.sessionId },
			hint: 'Wait, then run "forge down" again; or run "forge down --force" to kill them.',
		},
	);
}

/**
 * Wait for the target's barrier. A session directory that is gone was
 * deleted once its barrier was clear.
 *
 * @param seams - The clock, file system, and native addon.
 * @param files - The target's files.
 * @param boundMs - How long to wait.
 * @returns Where the barrier stands at the end.
 * @rejects When the lease cannot be read, and the directory is still there.
 */
async function barrierAsync(
	seams: DownSeams,
	files: SessionFiles,
	boundMs: number,
): Promise<Barrier> {
	try {
		if (seams.fileSystem.existsSync(files.directory)) {
			const barrier = await waitForBarrierAsync(seams, files, boundMs, NEVER);
			// It never aborts.
			assert(barrier !== undefined);
			return barrier;
		}
	} catch (err) {
		// The supervisor deleted it meanwhile, with its lease.
		if (seams.fileSystem.existsSync(files.directory)) {
			throw err;
		}
	}

	return { clear: true, pids: [] };
}

/**
 * Condition 2 of {@link stopSessionAsync}: the target's barrier clears;
 * with `--force`, after a forced cleanup of what outlived it.
 *
 * @param seams - The clock, file system, and native addon.
 * @param files - The target's files.
 * @param options - `--force` and the wait.
 * @returns The forced cleanup, when one ran.
 * @rejects {ForgeError} `cleanup_in_progress`; `cleanup_unverifiable`.
 */
async function clearBarrierAsync(
	seams: DownSeams,
	files: SessionFiles,
	{ force, timeoutMs }: DownOptions,
): Promise<CleanupReport | undefined> {
	const barrier = await barrierAsync(seams, files, timeoutMs);
	if (barrier.clear) {
		return undefined;
	}

	if (!force) {
		throw stillAlive(files, barrier.pids);
	}

	const cleanup = await seams.native().forceCleanup(targetOf(files), FORCED_CLEANUP_MS);
	if (cleanup.unverifiable.length > 0) {
		throw new ForgeError(
			"cleanup_unverifiable",
			`Processes of session ${files.sessionId} could not be verified, so they were not killed (PIDs ${cleanup.unverifiable.join(", ")}).`,
			{
				details: { cleanup, pids: cleanup.unverifiable, sessionId: files.sessionId },
				hint: `Check them, and stop them by hand. The session files are in ${files.directory}.`,
			},
		);
	}

	const after = await barrierAsync(seams, files, SETTLE_MS);
	if (!after.clear) {
		throw stillAlive(files, after.pids);
	}

	return cleanup;
}

/**
 * Delete the target's files, only while holding the singleton lock: a
 * session that holds it now is another one, and its startup barrier
 * deletes the target's files itself.
 *
 * @param seams - The file system and native addon.
 * @param forge - The project's `.forge` files.
 * @param files - The target's files.
 * @returns Whether it deleted them.
 */
function removeUnderLock(seams: DownSeams, forge: ForgeFiles, files: SessionFiles): boolean {
	if (!seams.fileSystem.existsSync(files.directory)) {
		return false;
	}

	const lock = seams.native().tryLockFile(forge.lock, "exclusive");
	if (lock === null) {
		return false;
	}

	try {
		removeSession(seams.fileSystem, forge, files.sessionId);
		return true;
	} finally {
		lock.release();
	}
}
