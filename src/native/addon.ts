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
	/**
	 * Force-kill the process group the pinned process leads (POSIX); the
	 * live leader pins the group id. On Windows, where jobs own trees, it
	 * kills the process only.
	 *
	 * @returns `false` when it had already exited.
	 */
	killGroup: () => boolean;
	/** The PID the process had when it was pinned. */
	readonly pid: number;
	/**
	 * Ask the pinned process to close, as a user would: `WM_CLOSE` to its
	 * main windows (visible, unowned, not tool or console windows) on
	 * Windows, `SIGTERM` elsewhere. It does not wait, and the process may
	 * refuse or ask its user first.
	 *
	 * @returns `false` when it had already exited, or on Windows has no main
	 *   window.
	 */
	requestClose: () => boolean;
	/** The start time read when it was pinned (see `processStartTime`). */
	readonly startTime: string;
	/**
	 * Block until the process exits or the timeout passes.
	 *
	 * @returns `true` once it has exited.
	 */
	waitForExit: (timeoutMs: number) => boolean;
}

/** What {@link NativePipeConnection.readLine} read. */
export interface NativeLineRead {
	kind: "closed" | "line" | "timed_out" | "too_long";
	/** The line, without its newline, when `kind` is `line`. */
	line?: string | undefined;
}

/** One client of a {@link NativePipeServer} (Windows). */
export interface NativePipeConnection {
	/** Close it; a pending read or write ends at once. */
	close: () => void;
	/** Read one line of at most `maxBytes`, waiting at most `timeoutMs`. */
	readLine: (maxBytes: number, timeoutMs: number) => Promise<NativeLineRead>;
	/**
	 * Write `text`, waiting at most `timeoutMs`.
	 *
	 * @returns `false` when the client left or the time passed first.
	 */
	write: (text: string, timeoutMs: number) => Promise<boolean>;
}

/** One access control entry of a {@link NativeSecurity}. */
export interface NativeAce {
	kind: "allow" | "deny" | "other";
	mask: number;
	/** `S-1-5-...`; empty for `other`. */
	sid: string;
}

/** The owner and DACL of a Windows object. */
export interface NativeSecurity {
	aces: Array<NativeAce>;
	owner: string;
	/** Inheritance from the parent is off. */
	protected: boolean;
}

/**
 * The server end of a named pipe (Windows): every instance has an
 * owner-only DACL and rejects remote clients (ADR 0001, "Pipe security").
 */
export interface NativePipeServer {
	/** Wait for the next client; `null` once the server is closed. */
	accept: () => Promise<NativePipeConnection | null>;
	/** Stop listening; a pending `accept` resolves `null`. */
	close: () => void;
	/** The pipe's owner and DACL. */
	security: () => NativeSecurity;
}

/** What {@link NativeAddon.spawnDetached} starts. */
export interface DetachedSpawn {
	args: Array<string>;
	cwd: string;
	/** The whole environment of the new process. */
	env: Record<string, string>;
	/** A file its stdout and stderr append to; `NUL` when missing. */
	output?: string;
	/** The executable's full path. */
	program: string;
}

/** One session's files: what the barrier and forced cleanup read. */
export interface SessionTarget {
	/** The lease file (`workers.lock`). */
	leasePath: string;
	/** The reaper record (`reaper.json`). */
	recordPath: string;
	sessionId: string;
}

/** A live process of a session. */
export interface SessionProcess {
	/** It is the session's reaper, as the reaper record names it. */
	isReaper: boolean;
	/** Its parent's PID (POSIX); 0 on Windows. */
	parentPid: number;
	pid: number;
	/** Its start time (see `processStartTime`). */
	startTime: string;
}

/** What a forced cleanup did. */
export interface CleanupReport {
	/** The PIDs it killed, in kill order: leaves first, the reaper last. */
	killed: Array<number>;
	/** Processes of the session still alive at the bound. */
	survivors: Array<number>;
	/** Processes whose ownership could not be read again: not killed. */
	unverifiable: Array<number>;
}

/** The addon's exports. */
export interface NativeAddon {
	/**
	 * Windows only: connect to the pipe at `path` as a client, waiting at most
	 * `timeoutMs` for a free instance. `node:net` would wait up to 30 s for a
	 * busy pipe, whatever its own timeout.
	 *
	 * @returns The connection, or `null` when there is no pipe or no instance
	 *   became free in time.
	 */
	connectPipe?: (path: string, timeoutMs: number) => Promise<NativePipeConnection | null>;
	/**
	 * Windows only: create the pipe at `path` (`\\.\pipe\<name>`) and its
	 * first instance.
	 *
	 * @throws When an instance of the name already exists (access denied).
	 */
	createPipeServer?: (path: string, rejectRemote: boolean) => NativePipeServer;
	/**
	 * Kill every process of a session within `boundMs`, off the main
	 * thread: each target pinned and its ownership read again through the
	 * pin, leaves first, the reaper last and only once nothing else is
	 * left. Unverifiable targets are reported, never killed.
	 */
	forceCleanup: (target: SessionTarget, boundMs: number) => Promise<CleanupReport>;
	/**
	 * Whether no one holds a lock on `path` now: takes an exclusive lock and
	 * lets go at once. Never creates the file, and a missing file is free,
	 * so a probe never races the delete of its directory.
	 *
	 * @throws When the file cannot be opened or locked.
	 */
	isLockFree: (path: string) => boolean;
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
	 * Every live process of a session: marker or lease holders (POSIX),
	 * members of its jobs (Windows), and its recorded reaper. Empty means
	 * the session's workers are gone.
	 */
	scanSession: (target: SessionTarget) => Array<SessionProcess>;
	/**
	 * Windows only: start a process outside this process's job
	 * (`CREATE_BREAKAWAY_FROM_JOB`), with no console and stdin from `NUL`.
	 *
	 * @returns Its PID, or `null` when the job forbids breakaway.
	 */
	spawnDetached?: (spawn: DetachedSpawn) => null | number;
	/**
	 * Lock `path` without waiting; creates the file when missing and never
	 * changes its content. Lock files should hold no data: Windows blocks
	 * reads of a locked file.
	 *
	 * @returns The lock, or `null` when another holder's lock conflicts.
	 */
	tryLockFile: (path: string, mode: LockMode) => FileLock | null;
	/**
	 * Windows only: create a new file that only the current user can open,
	 * holding `contents`. It never exists with another DACL.
	 *
	 * @throws When the file exists or cannot be written.
	 */
	writePrivateFile?: (path: string, contents: string) => void;
}

/**
 * Loads the addon on first use. Commands that never touch processes never
 * load it, so a missing native package fails only the commands that need it.
 * Throws a `ForgeError` with code `native_missing` when no build loads for
 * this OS.
 */
export type NativeLoader = () => NativeAddon;
