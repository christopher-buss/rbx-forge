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
	/**
	 * A modal dialog blocks its windows (`isBlocked`); `throw` makes the
	 * query fail.
	 */
	blocked?: "throw" | boolean;
	/** How many times `requestClose` reached it while it ran. */
	closeRequests?: number;
	executablePath: string;
	/** It exits right after it is pinned, before any query on the pin. */
	exitsAfterPin?: boolean;
	/** Set once `killGroup` ran on one of its pins. */
	groupKilled?: boolean;
	/** `kill` leaves it running (a process the OS cannot end in time). */
	ignoresKill?: boolean;
	/**
	 * Runs when a close request closes its place, such as to delete a lock
	 * file.
	 */
	onClose?: () => void;
	/**
	 * What `requestClose` does: `exit` (the default); `refuse` (it stays
	 * open and shows nothing); `dialog` (it stays open behind a modal
	 * dialog: `blocked`); `linger` (it closes its place, `onClose`, but
	 * the process runs on); `no_window` (it has no window to close:
	 * `false`); `exit_first` (it exits just before the request: `false`);
	 * or `throw` (the OS refuses the request).
	 */
	onCloseRequest?: "dialog" | "exit" | "exit_first" | "linger" | "no_window" | "refuse" | "throw";
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
 * @param registry - Registry default values by key (see
 *   {@link readFrom}); no registry read without it.
 * @returns The addon and its table.
 */
export function createFakeNative(
	processes: Record<number, FakeProcess> = {},
	registry?: Readonly<Record<string, null | string>>,
): FakeNative {
	const table = new Map(Object.entries(processes).map(([pid, entry]) => [Number(pid), entry]));
	const locks = new Map<string, Array<LockMode>>();
	const sessions = new Map<string, Array<FakeSessionProcess>>();
	const cleanups: Array<FakeCleanup> = [];
	const values = new Map(Object.entries(registry ?? {}));

	return {
		addon: {
			...sessionMembers(sessions, cleanups),
			...processMembers(table),
			isLockFree: (path) => !locks.has(path),
			nativeVersion: () => "0.0.0",
			tryLockFile: (path, mode) => lockIn(locks, path, mode),
			...(registry === undefined
				? {}
				: { readUserRegistryDefault: (key) => readFrom(values, key) }),
		},
		cleanups,
		locks,
		processes: table,
		sessions,
	};
}

function startTimeOf(pid: number, entry: FakeProcess): string {
	return entry.startTime ?? String(pid);
}

/**
 * What a close request that reached a running process does to it.
 *
 * @param entry - The process.
 */
function receiveClose(entry: FakeProcess): void {
	entry.closeRequests = (entry.closeRequests ?? 0) + 1;
	switch (entry.onCloseRequest) {
		case "dialog": {
			entry.blocked = true;
			break;
		}
		case "linger": {
			entry.onClose?.();
			break;
		}
		case "refuse": {
			break;
		}
		case "exit":
		case "exit_first":
		case "no_window":
		case "throw":
		case undefined: {
			entry.alive = false;
			entry.onClose?.();
		}
	}
}

/**
 * A close request on a fake process, as {@link FakeProcess.onCloseRequest}
 * says.
 *
 * @param entry - The process.
 * @returns `false` when it had already exited or has no window.
 */
function requestClose(entry: FakeProcess): boolean {
	if (!entry.alive || entry.onCloseRequest === "no_window") {
		return false;
	}

	if (entry.onCloseRequest === "exit_first") {
		entry.alive = false;
		return false;
	}

	if (entry.onCloseRequest === "throw") {
		throw new Error("close process: Access is denied. (os error 5)");
	}

	receiveClose(entry);
	return true;
}

/**
 * The fake's `isBlocked`.
 *
 * @param pid - The PID, for the error.
 * @param entry - The process.
 * @returns Whether a dialog blocks it.
 */
function blockedNow(pid: number, entry: FakeProcess): boolean {
	if (entry.blocked === "throw") {
		throw new Error(`windows of process ${pid}: Access is denied. (os error 5)`);
	}

	return entry.alive && entry.blocked === true;
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
		isBlocked: () => blockedNow(pid, entry),
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

/**
 * The process members of the fake addon, over its process table.
 *
 * @param table - The process table, by PID.
 * @returns `pinProcess` and `processStartTime`.
 */
function processMembers(
	table: ReadonlyMap<number, FakeProcess>,
): Pick<NativeAddon, "pinProcess" | "processStartTime"> {
	return {
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
	};
}

/**
 * A registry read over a table of keys; a `null` value fails the read.
 *
 * @param registry - Default values by key.
 * @param key - The key to read.
 * @returns Its value; `null` when the table has no such key.
 */
function readFrom(registry: ReadonlyMap<string, null | string>, key: string): null | string {
	if (!registry.has(key)) {
		return null;
	}

	const value = registry.get(key);
	if (value === null || value === undefined) {
		throw new Error(`read HKCU\\${key}: The data is invalid.`);
	}

	return value;
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
