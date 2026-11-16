import { type } from "arktype";

import type { ChildProcessBackend } from "../process/process-runner.ts";
import type { Environment, Seams } from "../seams/seams.ts";
import type { PinnedStudio } from "../seams/studio-host.ts";
import { parseStatus } from "../session/status.ts";
import { STUDIO_OPEN_BOUND_MS } from "../session/studio-readiness.ts";
import { forgeFiles, listSessions, sessionFiles } from "../supervisor/session-files.ts";
import { hasStudioLock } from "./lock-file.ts";
import { KEEP_HIDDEN_POLL_MS } from "./window-hiding.ts";

/** How long Studio stays hidden after its place opens before the watch ends. */
export const KEEP_HIDDEN_QUIET_MS = 3000;

/** The supervisor entry flag that runs {@link keepStudioHiddenAsync}. */
export const KEEP_HIDDEN_FLAG = "--keep-studio-hidden";

/** One exact Studio to keep hidden, and the place it opens. */
export interface KeepHiddenTarget {
	/** Windows keeps hiding until explicitly stopped or Studio exits. */
	isWindows?: boolean;
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
	"isWindows?": "boolean",
	"pid": "number.integer > 0",
	"place": "string",
	"startTime": "string > 0",
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
		// Detached ownership keeps the watcher alive after the launcher exits.
		child.once("error", ignoreError);
		child.unref();
	};
}

/**
 * Keep a Windows watcher alive until stopped or Studio exits. On macOS,
 * hide one exact Studio every time it shows itself while loading,
 * until its place lock exists and it has stayed hidden for
 * {@link KEEP_HIDDEN_QUIET_MS}, it exits, a session records another desktop
 * for it, or the open bound passes.
 *
 * @param seams - The place lock, session states, native process identity, and polling clock.
 * @param payload - The {@link KeepHiddenTarget} as JSON.
 * @param root - The project directory, whose sessions may show Studio.
 * @returns Resolves when hiding ends.
 */
// eslint-disable-next-line flawless/max-lines-per-function -- Owns the watcher subscription for its entire lifetime.
export async function keepStudioHiddenAsync(
	seams: Pick<Seams, "clock" | "fileSystem" | "studioHost">,
	payload: string,
	root: string,
): Promise<void> {
	const { isWindows, pid, place, startTime } = keepHiddenTarget.assert(JSON.parse(payload));
	const pinned = await seams.studioHost.pinProcessAsync(pid);
	if (pinned?.startTime !== startTime) {
		return;
	}

	if (isWindows === true) {
		if (
			isShownBySession(seams.fileSystem, root, { pid, startTime }) &&
			(await pinned.windowVisibilityAsync()) === "user"
		) {
			return;
		}

		let didRecover = false;
		const dispose = seams.studioHost.onControl?.((state) => {
			if (state === "recovering") {
				didRecover = true;
			}
		});
		try {
			await keepWindowsHiddenAsync(pinned, seams, root, { pid, startTime }, () => {
				const didRecoverNow = didRecover;
				didRecover = false;
				return didRecoverNow;
			});
			return;
		} finally {
			dispose?.();
		}
	}

	await keepMacStudioHiddenAsync(seams, pinned, { pid, place, startTime }, root);
}

function ignoreError(): void {
	// The launch already succeeded; the watcher is best effort.
}

function isShownBySession(
	fileSystem: Seams["fileSystem"],
	root: string,
	{ pid, startTime }: Pick<KeepHiddenTarget, "pid" | "startTime">,
): boolean {
	const forge = forgeFiles(root);
	return listSessions(fileSystem, forge).some((id) => {
		const { state } = sessionFiles(forge, id);
		const studio = fileSystem.existsSync(state)
			? parseStatus(JSON.parse(fileSystem.readFileSync(state, "utf8")))?.services.studio
			: undefined;
		return studio?.pid === pid && studio.startTime === startTime && studio.desktop === "user";
	});
}

async function hideInactiveAsync(pinned: PinnedStudio): Promise<void> {
	// An active Studio is never re-hidden.
	if ((await pinned.appActiveAsync()) !== true) {
		await pinned.setAppHiddenAsync(true);
	}
}

async function keepMacStudioHiddenAsync(
	seams: Pick<Seams, "clock" | "fileSystem">,
	pinned: PinnedStudio,
	{ pid, place, startTime }: KeepHiddenTarget,
	root: string,
): Promise<void> {
	const { clock } = seams;

	const deadline = clock.now() + STUDIO_OPEN_BOUND_MS;
	let quietSince = clock.now();
	let isOpen = false;
	while ((await pinned.isAliveAsync()) && clock.now() < deadline) {
		if ((await pinned.appHiddenAsync()) === false) {
			if (isShownBySession(seams.fileSystem, root, { pid, startTime })) {
				return;
			}

			await hideInactiveAsync(pinned);
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

// eslint-disable-next-line better-max-params/better-max-params -- The recovery observation belongs to this detached watcher.
async function keepWindowsHiddenAsync(
	pinned: PinnedStudio,
	seams: Pick<Seams, "clock" | "fileSystem">,
	root: string,
	target: Pick<KeepHiddenTarget, "pid" | "startTime">,
	recovered: () => boolean,
): Promise<void> {
	if (!(await pinned.startWindowHidingAsync())) {
		return;
	}

	for (;;) {
		const isHiding = await pinned.windowHidingAsync();
		if (recovered()) {
			if (isShownBySession(seams.fileSystem, root, target)) {
				await pinned.stopWindowHidingAsync();
				return;
			}

			if (!(await pinned.startWindowHidingAsync())) {
				return;
			}
		} else if (!isHiding) {
			return;
		}

		if (
			isShownBySession(seams.fileSystem, root, target) &&
			(await pinned.windowVisibilityAsync()) === "user"
		) {
			await pinned.stopWindowHidingAsync();
			return;
		}

		await seams.clock.sleep(KEEP_HIDDEN_POLL_MS);
	}
}
