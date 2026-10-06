import { type } from "arktype";

import type { ChildProcessBackend } from "../process/process-runner.ts";
import type { Environment, Seams } from "../seams/seams.ts";
import { STUDIO_OPEN_BOUND_MS } from "../session/studio-readiness.ts";
import { hasStudioLock } from "./lock-file.ts";

/** How often the watcher reads Studio's app visibility. */
export const KEEP_HIDDEN_POLL_MS = 10;

/** How long Studio stays hidden after its place opens before the watch ends. */
export const KEEP_HIDDEN_QUIET_MS = 3000;

/** The supervisor entry flag that runs {@link keepStudioHiddenAsync}. */
export const KEEP_HIDDEN_FLAG = "--keep-studio-hidden";

/** One exact Studio to keep hidden, and the place it opens. */
export interface KeepHiddenTarget {
	pid: number;
	place: string;
	startTime: string;
}

/** Starts a watcher that outlives the command that launched Studio. */
export type KeepHiddenLauncher = (launch: {
	cwd: string;
	env: Environment;
	target: KeepHiddenTarget;
}) => void;

const keepHiddenTarget = type({
	pid: "number.integer > 0",
	place: "string",
	startTime: "string > 0",
});

/**
 * Start the keep-hidden watcher detached, through the supervisor entry.
 *
 * @param backend - The spawn seam and current Node executable.
 * @param entry - The supervisor entry script.
 * @returns A launcher independent of the launching command's lifetime.
 */
export function createKeepHiddenLauncher(
	backend: Pick<ChildProcessBackend, "childProcess" | "host">,
	entry: string,
): KeepHiddenLauncher {
	return ({ cwd, env, target }) => {
		const child = backend.childProcess.spawn(
			backend.host.execPath,
			[entry, KEEP_HIDDEN_FLAG, JSON.stringify(target)],
			{ cwd, detached: true, env, stdio: "ignore", windowsHide: true },
		);
		// Without the watcher, Studio only shows itself briefly while loading.
		child.once("error", ignoreError);
		child.unref();
	};
}

/**
 * Hide one exact macOS Studio every time it shows itself while loading,
 * until its place lock exists and it has stayed hidden for
 * {@link KEEP_HIDDEN_QUIET_MS}, it exits, or the open bound passes.
 *
 * @param seams - The place lock, native process identity, and polling clock.
 * @param payload - The {@link KeepHiddenTarget} as JSON.
 */
export async function keepStudioHiddenAsync(
	seams: Pick<Seams, "clock" | "fileSystem" | "native">,
	payload: string,
): Promise<void> {
	const { pid, place, startTime } = keepHiddenTarget.assert(JSON.parse(payload));
	const pinned = seams.native().pinProcess(pid);
	if (pinned?.startTime !== startTime) {
		return;
	}

	const { clock } = seams;
	const deadline = clock.now() + STUDIO_OPEN_BOUND_MS;
	let quietSince = clock.now();
	let isOpen = false;
	while (pinned.isAlive() && clock.now() < deadline) {
		if (pinned.appHidden() === false) {
			pinned.setAppHidden(true);
			quietSince = clock.now();
		}

		if (!isOpen && hasStudioLock(seams.fileSystem, { pid, place })) {
			isOpen = true;
			quietSince = clock.now();
		}

		if (isOpen && clock.now() - quietSince >= KEEP_HIDDEN_QUIET_MS) {
			return;
		}

		await clock.sleep(KEEP_HIDDEN_POLL_MS);
	}
}

function ignoreError(): void {
	// The launch already succeeded; the watcher is best effort.
}
