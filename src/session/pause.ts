import path from "node:path";

import type { Clock } from "../seams/clock.ts";
import type { FileSystem } from "../seams/file-system.ts";

/**
 * Fault-injection pause points of a supervisor's startup (spec #28, Testing).
 * Tests stop the supervisor at one of them, act (kill `forge start`, run a
 * second session), and resume it. In order:
 *
 * - `created`: first instruction; the owner pipe is already watched.
 * - `lock`: before the singleton lock.
 * - `control`: the session's files and `current` exist; before its
 *   endpoint opens and before its reaper starts.
 * - `leased`: the reaper holds its lease; before `go`.
 * - `admitted`: right after `go`; before any worker.
 */
export type PausePoint = "admitted" | "control" | "created" | "leased" | "lock";

/**
 * Wait at a pause point. Resolves when the test resumes it, or at once when
 * `signal` aborts (the session is stopping), so a pause never holds up a
 * shutdown. Production passes {@link neverPauseAsync}.
 */
export type Pause = (point: PausePoint, signal: AbortSignal) => Promise<void>;

/** How often a paused supervisor looks for its resume. */
export const PAUSE_POLL_MS = 50;

/** What a test pause runs with. */
export interface FilePauseOptions {
	clock: Clock;
	/** Where the pause files go. */
	directory: string;
	fileSystem: Pick<FileSystem, "existsSync" | "mkdirSync" | "writeFileSync">;
	/** This process's PID, written into each pause file. */
	pid: number;
	/** The points that pause; others pass. */
	points: ReadonlySet<string>;
}

/** The pause of every real run: it never waits. */
export async function neverPauseAsync(): Promise<void> {
	// Not paused.
}

/**
 * A pause for tests: at a listed point it writes `<directory>/<point>.paused`
 * (content: this PID) and waits until the test deletes that file. Only a test
 * environment variable enables it (see `src/supervisor.ts`).
 *
 * @param options - The pause directory, points, clock, and file system.
 * @returns A pause that waits at the listed points.
 */
export function createFilePause({
	clock,
	directory,
	fileSystem,
	pid,
	points,
}: FilePauseOptions): Pause {
	return async (point, signal) => {
		if (!points.has(point)) {
			return;
		}

		const file = path.join(directory, `${point}.paused`);
		fileSystem.mkdirSync(directory, { recursive: true });
		fileSystem.writeFileSync(file, String(pid));
		while (fileSystem.existsSync(file)) {
			try {
				await clock.sleep(PAUSE_POLL_MS, signal);
			} catch {
				// Aborted: the session is stopping.
				return;
			}
		}
	};
}

/**
 * The points a pause variable lists.
 *
 * @param variable - Such as `lock,leased`; `undefined` or empty for none.
 * @returns The listed point names, without empty entries.
 */
export function parsePausePoints(variable: string | undefined): ReadonlySet<string> {
	return new Set((variable ?? "").split(",").filter((point) => point !== ""));
}
