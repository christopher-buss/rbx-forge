import assert from "node:assert/strict";

import type { AutoRecoveryMode } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import { callSessionAsync } from "../ipc/client.ts";
import type { CleanupReport, PinnedProcess } from "../native/addon.ts";
import { FORCED_CLEANUP_MS } from "../reaper/reaper-client.ts";
import type { Seams } from "../seams/seams.ts";
import type { Barrier } from "../supervisor/barrier.ts";
import { SETTLE_MS, targetOf, waitForBarrierAsync } from "../supervisor/barrier.ts";
import type { ForgeFiles, SessionFiles } from "../supervisor/session-files.ts";
import { removeSession } from "../supervisor/session-files.ts";
import type { DownParts, DownStudio } from "./down-parts.ts";
import { askPartStopsAsync, downStudio } from "./down-parts.ts";
import type { KnownSession } from "./session.ts";

/** How long `down` waits after its first shutdown request. */
export const DOWN_TIMEOUT_MS = 15_000;
/** How long `down` waits after a forced shutdown request. */
export const FORCED_SHUTDOWN_MS = 5000;
/** How long `down --force` waits for the supervisor it killed. */
export const KILL_WAIT_MS = 5000;

/** How often `down` looks at the supervisor again. */
const DOWN_POLL_MS = 100;

/** A barrier wait nothing aborts. */
const NEVER = AbortSignal.any([]);

/** The seams `down` runs with. */
export type DownSeams = Pick<Seams, "clock" | "fileSystem" | "host" | "ipc" | "native">;

/** Where a test can hold `down` up: before the barrier, before the delete. */
export type DownPoint = "barrier" | "delete";

/** How `down` stops a session. */
export interface DownOptions {
	/**
	 * `--force`: kill a supervisor that does not stop (through its pinned,
	 * start-time-verified handle), and kill what outlives the barrier.
	 */
	force: boolean;
	/** `--keep-studio`: leave the session's Studio open. */
	keepStudio: boolean;
	/** Test only: waits at each point. */
	pause?: ((point: DownPoint) => Promise<void>) | undefined;
	/** What to do with the auto-recovery files of a Studio `down` ends. */
	recovery: AutoRecoveryMode;
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

/**
 * What `down` did: `stopped` once the session is gone, or `running` when
 * parts with an owner keep it.
 */
export type DownReport =
	| {
			/** The forced cleanup of processes that outlived the barrier. */
			cleanup?: CleanupReport;
			parts: DownParts;
			/** `down` deleted the session's files; else its supervisor had. */
			removed: boolean;
			sessionId: string;
			status: "stopped";
			stoppedBy: StoppedBy;
			studio: DownStudio;
	  }
	| {
			parts: NonNullable<DownParts>;
			sessionId: string;
			status: "running";
			studio: DownStudio;
	  };

/** The target's supervisor, pinned when it still runs. */
interface Target {
	forge: ForgeFiles;
	/** Its pin; `undefined` when the recorded process is gone. */
	pin: PinnedProcess | undefined;
	session: KnownSession;
}

/**
 * Stop the parts of one session that have no owner and, once none is left,
 * prove the session gone. It acts on this session only: requests carry its
 * id, pins its recorded supervisor, and cleans up and deletes only its
 * files.
 *
 * First it asks the session to stop its parts (IPC `stopParts`, scope
 * `down`): the session closes its Studio (unless `keepStudio`), stops Rojo
 * and the compiler, and ends once no part is left. Parts with an owner stay;
 * then the session goes on, and `down` reports it `running`. A session
 * that is still starting answers once it started its parts. A session that does
 * not answer, or is stopping, is stopped whole; one with an owned part is
 * not, unless `force`. `stopped` needs both:
 *
 * 1. Its supervisor has exited: its pinned process (PID plus start time)
 *    is gone. A supervisor lets go of the singleton lock before it writes
 *    its result, and can hang there, so a free lock proves nothing while
 *    the pinned process runs.
 * 2. Its barrier is clear: its lease is free and a scan finds none of its
 *    processes.
 *
 * Escalation: IPC `shutdown` (wait `timeoutMs`), IPC `shutdown` with `force`
 * (wait {@link FORCED_SHUTDOWN_MS}), then, with `force` only, kill the
 * supervisor through its pin while it holds the singleton lock; and, when the
 * barrier stays blocked, with `force` only, a forced cleanup of the session.
 * Its files are deleted only under the singleton lock.
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
	const stops = isGone(target) ? undefined : await askPartStopsAsync(seams.ipc, session, options);
	const parts = stops === undefined ? null : { kept: stops.kept, stopped: stops.stopped };
	const studio = downStudio(stops, options.keepStudio);
	const { sessionId } = session.identity;
	if (parts !== null && stops?.ending === false) {
		return { parts, sessionId, status: "running", studio };
	}

	const stoppedBy = await stopSupervisorAsync(seams, target, options);
	await options.pause?.("barrier");
	const cleanup = await clearBarrierAsync(seams, session.files, options);
	await options.pause?.("delete");
	return {
		...(cleanup === undefined ? {} : { cleanup }),
		parts,
		removed: removeUnderLock(seams, forge, session.files),
		sessionId,
		status: "stopped",
		stoppedBy,
		studio,
	};
}

/**
 * Condition 1 of {@link stopSessionAsync}: the target's supervisor has
 * exited.
 *
 * @param target - The pinned supervisor.
 * @param target.pin - Its pin; `undefined` when it was gone at the start.
 * @returns Whether it has.
 */
function isGone({ pin }: Target): boolean {
	return pin?.isAlive() !== true;
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
 * Whether a process holds the project's singleton lock. The probe never
 * creates the lock file.
 *
 * @param seams - The native addon.
 * @param forge - The project's `.forge` files.
 * @returns Whether the lock is held.
 */
function isLockHeld(seams: Pick<DownSeams, "native">, forge: ForgeFiles): boolean {
	return !seams.native().isLockFree(forge.lock);
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
 * Ask the target to stop until it accepts, and wait until it is gone. It
 * asks at least once, also with no wait (`--timeout 0`).
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
	let isAccepted = await askAsync(seams, target.session, force);
	for (;;) {
		if (isGone(target)) {
			return true;
		}

		if (seams.clock.now() >= deadline) {
			return false;
		}

		await seams.clock.sleep(DOWN_POLL_MS);
		isAccepted ||= await askAsync(seams, target.session, force);
	}
}

async function waitGoneAsync(seams: DownSeams, target: Target, waitMs: number): Promise<boolean> {
	const deadline = seams.clock.now() + waitMs;
	while (!isGone(target)) {
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
 * Condition 1 of {@link stopSessionAsync}, with its escalation. A session
 * that ends by itself once its parts stopped accepts the request too.
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
	if (isGone(target)) {
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

	// Kill only a supervisor of this project: pinned with its recorded start
	// time, and holding the singleton lock. A live process with that PID and
	// start time but no lock is not one.
	if (!isLockHeld(seams, target.forge)) {
		throw unresponsive(target, true);
	}

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
