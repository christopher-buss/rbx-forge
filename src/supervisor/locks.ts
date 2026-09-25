import { ForgeError } from "../errors.ts";
import type { FileLock, NativeLoader } from "../native/addon.ts";
import type { Clock } from "../seams/clock.ts";
import type { FileSystem } from "../seams/file-system.ts";
import type { ForgeFiles } from "./session-files.ts";

/** How often a wait for a lease or a barrier tries again. */
export const LEASE_POLL_MS = 100;

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
