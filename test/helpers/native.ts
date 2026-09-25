import type { FileLock, LockMode, NativeAddon, PinnedProcess } from "../../src/native/addon.ts";

/** One process in the fake process table. */
export interface FakeProcess {
	alive: boolean;
	executablePath: string;
	/** It exits right after it is pinned, before any query on the pin. */
	exitsAfterPin?: boolean;
	/** Set once `killGroup` ran on one of its pins. */
	groupKilled?: boolean;
	/** `kill` leaves it running (a process the OS cannot end in time). */
	ignoresKill?: boolean;
	/** `pinProcess` throws this message (for example, access denied). */
	pinError?: string;
	/** Its start time as the addon reports it; the PID when not set. */
	startTime?: string;
	/** The timeout of every `waitForExit` call on its pins. */
	waits?: Array<number>;
}

/** A fake addon over an in-memory process table and lock table. */
export interface FakeNative {
	addon: NativeAddon;
	/** The locks held now, by path: one mode per holder. */
	locks: Map<string, Array<LockMode>>;
	/** The process table, by PID. Tests read `alive` after a run. */
	processes: Map<number, FakeProcess>;
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

	return {
		addon: {
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
		locks,
		processes: table,
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
		startTime: startTimeOf(pid, entry),
		waitForExit: (timeoutMs) => {
			entry.waits?.push(timeoutMs);
			return !entry.alive;
		},
	};
}
