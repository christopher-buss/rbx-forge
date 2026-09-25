/**
 * The `@rbx-forge/native` addon surface, written by hand: the build uses
 * `napi build --no-js`, so nothing is generated. Each member mirrors one
 * `#[napi]` export in `reaper/src/lib.rs`; change both together.
 *
 * "Not there" outcomes (a conflicting lock, no live process) are `null`.
 * OS failures throw an `Error` whose message names the call.
 */

/** How a file lock shares its file. */
export type LockMode = "exclusive" | "shared";

/**
 * A held file lock. The OS releases it when the holder dies, on
 * {@link FileLock.release}, or when the object is garbage collected, so keep a
 * reference for as long as the lock must hold.
 */
export interface FileLock {
	/** Release the lock. Safe to call more than once. */
	release: () => void;
}

/**
 * A process held by identity: a Windows handle, a Linux pidfd, or on macOS
 * the PID plus its start time, checked before every call. Every method acts
 * on the pinned process or reports that it exited; none reaches a process
 * that reused the PID.
 */
export interface PinnedProcess {
	/** Full path of the executable, or `null` once the process has exited. */
	executablePath: () => null | string;
	/** Whether the pinned process still runs. */
	isAlive: () => boolean;
	/**
	 * Force-kill the pinned process only, not its children.
	 *
	 * @returns `false` when it had already exited.
	 */
	kill: () => boolean;
	/** The PID the process had when it was pinned. */
	readonly pid: number;
	/** The start time read when it was pinned (see `processStartTime`). */
	readonly startTime: string;
	/**
	 * Block until the process exits or the timeout passes.
	 *
	 * @returns `true` once it has exited.
	 */
	waitForExit: (timeoutMs: number) => boolean;
}

/** The addon's exports. */
export interface NativeAddon {
	/** Version of the native crate. */
	nativeVersion: () => string;
	/** Pin the live process with this PID, or `null` when there is none. */
	pinProcess: (pid: number) => null | PinnedProcess;
	/**
	 * Start time of a live process as a decimal string, or `null` when no
	 * live process has this PID. The unit differs per OS (Windows `FILETIME`,
	 * Linux clock ticks since boot, macOS microseconds), so compare values
	 * only on one machine. With the PID it names exactly one process.
	 */
	processStartTime: (pid: number) => null | string;
	/**
	 * Lock `path` without waiting; creates the file when missing and never
	 * changes its content. Lock files should hold no data: Windows blocks
	 * reads of a locked file.
	 *
	 * @returns The lock, or `null` when another holder's lock conflicts.
	 */
	tryLockFile: (path: string, mode: LockMode) => FileLock | null;
}

/**
 * Loads the addon on first use. Commands that never touch processes never
 * load it, so a missing native package fails only the commands that need it.
 * Throws a `ForgeError` with code `native_missing` when no build loads for
 * this OS.
 */
export type NativeLoader = () => NativeAddon;
