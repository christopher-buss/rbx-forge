import type { NativeAddon, PinnedProcess } from "../../src/native/addon.ts";

/** One process in the fake process table. */
export interface FakeProcess {
	alive: boolean;
	executablePath: string;
	/** `kill` leaves it running (a process the OS cannot end in time). */
	ignoresKill?: boolean;
	/** `pinProcess` throws this message (for example, access denied). */
	pinError?: string;
}

/** A fake addon over an in-memory process table. */
export interface FakeNative {
	addon: NativeAddon;
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
			processStartTime: (pid) => (table.get(pid)?.alive === true ? String(pid) : null),
			tryLockFile: () => {
				throw new Error("the fake addon has no file locks");
			},
		},
		processes: table,
	};
}

function pinEntry(pid: number, entry: FakeProcess): PinnedProcess {
	return {
		executablePath: () => (entry.alive ? entry.executablePath : null),
		isAlive: () => entry.alive,
		kill: () => {
			const wasAlive = entry.alive;
			entry.alive = entry.ignoresKill === true && wasAlive;
			return wasAlive;
		},
		pid,
		startTime: String(pid),
		waitForExit: () => !entry.alive,
	};
}
