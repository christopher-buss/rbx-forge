import type {
	CleanupReport,
	FileLock,
	LockMode,
	NativeAddon,
	PinnedProcess,
	SessionProcess,
	SessionTarget,
} from "../../src/native/addon.ts";

/** One process in the fake process table. */
export interface FakeProcess {
	alive: boolean;
	/** How many times `requestClose` reached it while it ran. */
	closeRequests?: number;
	executablePath: string;
	/** It exits right after it is pinned, before any query on the pin. */
	exitsAfterPin?: boolean;
	/** Set once `killGroup` ran on one of its pins. */
	groupKilled?: boolean;
	/** `kill` leaves it running (a process the OS cannot end in time). */
	ignoresKill?: boolean;
	/** Runs when a close request ends it, such as to delete a lock file. */
	onClose?: () => void;
	/**
	 * What `requestClose` does: `exit` (the default); `refuse` (it stays
	 * open, as Studio does while it asks to save); `no_window` (it has no
	 * window to close: `false`); `exit_first` (it exits just before the
	 * request: `false`); or `throw` (the OS refuses the request).
	 */
	onCloseRequest?: "exit" | "exit_first" | "no_window" | "refuse" | "throw";
	/** `pinProcess` throws this message (for example, access denied). */
	pinError?: string;
	/** Its start time as the addon reports it; the PID when not set. */
	startTime?: string;
	/** The timeout of every `waitForExit` call on its pins. */
	waits?: Array<number>;
}

/** A process of a session in the fake session table. */
export interface FakeSessionProcess extends Partial<SessionProcess> {
	/** Released when forced cleanup kills it: the lease it holds. */
	lease?: FileLock;
	/** Forced cleanup cannot end it in time. */
	survivesCleanup?: boolean;
	/** Forced cleanup cannot read its ownership again. */
	unverifiable?: boolean;
}

/** One `forceCleanup` call. */
export interface FakeCleanup {
	boundMs: number;
	target: SessionTarget;
}

/** A fake addon over an in-memory process table and lock table. */
export interface FakeNative {
	addon: NativeAddon;
	/** Every `forceCleanup` call, in order. */
	cleanups: Array<FakeCleanup>;
	/** The locks held now, by path: one mode per holder. */
	locks: Map<string, Array<LockMode>>;
	/** The process table, by PID. Tests read `alive` after a run. */
	processes: Map<number, FakeProcess>;
	/**
	 * Each session's live processes, by session id: what `scanSession`
	 * lists. Forced cleanup removes the ones it kills.
	 */
	sessions: Map<string, Array<FakeSessionProcess>>;
}

/**
 * A fake `@rbx-forge/native` for unit tests. A pin holds the table entry,
 * not the PID, so replacing the entry for a PID (a reused PID) never changes
 * what an older pin acts on, as with the real addon.
 *
 * @param processes - The process table, by PID.
 * @returns The addon and its table.
 */
export function createFakeNative(processes: Record<number, FakeProcess> = {}): FakeNative {
	const table = new Map(Object.entries(processes).map(([pid, entry]) => [Number(pid), entry]));
	const locks = new Map<string, Array<LockMode>>();
	const sessions = new Map<string, Array<FakeSessionProcess>>();
	const cleanups: Array<FakeCleanup> = [];

	return {
		addon: {
			...sessionMembers(sessions, cleanups),
			isLockFree: (path) => !locks.has(path),
			nativeVersion: () => "0.0.0",
			pinProcess: (pid) => {
				const entry = table.get(pid);
				if (entry?.pinError !== undefined) {
					throw new Error(entry.pinError);
				}

				return entry?.alive === true ? pinEntry(pid, entry) : null;
			},
			processStartTime: (pid) => {
				const entry = table.get(pid);
				return entry?.alive === true ? startTimeOf(pid, entry) : null;
			},
			tryLockFile: (path, mode) => lockIn(locks, path, mode),
		},
		cleanups,
		locks,
		processes: table,
		sessions,
	};
}

function toSessionProcess(entry: FakeSessionProcess, index: number): SessionProcess {
	return {
		isReaper: entry.isReaper ?? false,
		parentPid: entry.parentPid ?? 0,
		pid: entry.pid ?? 1000 + index,
		startTime: entry.startTime ?? "1",
	};
}

/**
 * Forced cleanup over the session table: kill every process but the
 * unverifiable and surviving ones, the reaper last.
 *
 * @param sessions - The session table.
 * @param sessionId - The session to clean up.
 * @returns The report.
 */
function cleanUp(
	sessions: Map<string, Array<FakeSessionProcess>>,
	sessionId: string,
): CleanupReport {
	const entries = sessions.get(sessionId) ?? [];
	const report: CleanupReport = { killed: [], survivors: [], unverifiable: [] };
	const left: Array<FakeSessionProcess> = [];
	const ordered = [
		...entries.filter(({ isReaper }) => isReaper !== true),
		...entries.filter(({ isReaper }) => isReaper === true),
	];
	for (const [index, entry] of ordered.entries()) {
		const { pid } = toSessionProcess(entry, index);
		if (entry.unverifiable === true) {
			report.unverifiable.push(pid);
			left.push(entry);
		} else if (entry.survivesCleanup === true) {
			report.survivors.push(pid);
			left.push(entry);
		} else {
			report.killed.push(pid);
			entry.lease?.release();
		}
	}

	sessions.set(sessionId, left);
	return report;
}

function sessionMembers(
	sessions: Map<string, Array<FakeSessionProcess>>,
	cleanups: Array<FakeCleanup>,
): Pick<NativeAddon, "forceCleanup" | "scanSession"> {
	return {
		forceCleanup: async (target, boundMs) => {
			cleanups.push({ boundMs, target });
			// A tick, as the real cleanup runs off the main thread.
			await Promise.resolve();
			return cleanUp(sessions, target.sessionId);
		},
		scanSession: (target) => (sessions.get(target.sessionId) ?? []).map(toSessionProcess),
	};
}

/**
 * Take a lock in the lock table, as `flock` or `LockFileEx` would: shared
 * locks coexist; an exclusive one excludes every other.
 *
 * @param locks - The lock table.
 * @param path - The lock file.
 * @param mode - How to lock it.
 * @returns The lock, or `null` when a held lock conflicts.
 */
function lockIn(
	locks: Map<string, Array<LockMode>>,
	path: string,
	mode: LockMode,
): FileLock | null {
	const held = locks.get(path) ?? [];
	const isBlocked = mode === "exclusive" ? held.length > 0 : held.includes("exclusive");
	if (isBlocked) {
		return null;
	}

	locks.set(path, [...held, mode]);
	let isHeld = true;
	return {
		release: () => {
			if (!isHeld) {
				return;
			}

			isHeld = false;
			const rest = [...(locks.get(path) ?? [])];
			rest.splice(rest.indexOf(mode), 1);
			if (rest.length === 0) {
				locks.delete(path);
			} else {
				locks.set(path, rest);
			}
		},
	};
}

function startTimeOf(pid: number, entry: FakeProcess): string {
	return entry.startTime ?? String(pid);
}

/**
 * A close request on a fake process, as {@link FakeProcess.onCloseRequest}
 * says.
 *
 * @param entry - The process.
 * @returns `false` when it had already exited or has no window.
 */
function requestClose(entry: FakeProcess): boolean {
	if (!entry.alive) {
		return false;
	}

	switch (entry.onCloseRequest) {
		case "exit_first": {
			entry.alive = false;
			return false;
		}
		case "no_window": {
			return false;
		}
		case "throw": {
			throw new Error("close process: Access is denied. (os error 5)");
		}
		case "exit":
		case "refuse":
		case undefined: {
			break;
		}
	}

	entry.closeRequests = (entry.closeRequests ?? 0) + 1;
	if (entry.onCloseRequest !== "refuse") {
		entry.alive = false;
		entry.onClose?.();
	}

	return true;
}

function pinEntry(pid: number, entry: FakeProcess): PinnedProcess {
	if (entry.exitsAfterPin === true) {
		entry.alive = false;
	}

	function kill(): boolean {
		const wasAlive = entry.alive;
		entry.alive = entry.ignoresKill === true && wasAlive;
		return wasAlive;
	}

	return {
		executablePath: () => (entry.alive ? entry.executablePath : null),
		isAlive: () => entry.alive,
		kill,
		killGroup: () => {
			entry.groupKilled = true;
			return kill();
		},
		pid,
		requestClose: () => requestClose(entry),
		startTime: startTimeOf(pid, entry),
		waitForExit: (timeoutMs) => {
			entry.waits?.push(timeoutMs);
			return !entry.alive;
		},
	};
}
