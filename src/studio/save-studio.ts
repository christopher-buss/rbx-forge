import type { Stats } from "node:fs";

import type { CaptureWarning } from "../capture/protocol.ts";
import type { SaveMethod } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import type { SaveOutcome } from "../native/addon.ts";
import { isHelperChannelLoss } from "../native/helper-client.ts";
import type { PinnedStudio } from "../seams/studio-host.ts";
import type { StudioSeams, StudioTarget } from "./close-studio.ts";
import { findPlaceStudioAsync } from "./close-studio.ts";
import { dismissLightingDialogAsync } from "./lighting-dialog.ts";

export interface StudioSave {
	bytes: number;
	desktop: "hidden" | "user";
	durationMs: number;
	method: SaveMethod;
	mtime: string;
	pid: number;
	place: string;
	warnings?: Array<CaptureWarning>;
}

export const STUDIO_SAVE_TIMEOUT_MS = 30_000;

const POLL_MS = 100;
const STABLE_MS = 250;
/** How often priming reads Save to File; Studio shows until it enables. */
const PRIME_POLL_MS = 10;
/** The longest priming keeps Studio visible. */
export const PRIME_LIMIT_MS = 5000;

/**
 * Save a verified Studio and wait until its changed place file settles.
 * @param seams - Files, time, and the native addon.
 * @param target - The Studio and its place.
 * @param timeoutMs - The deadline from the start of this save.
 * @param signal - The session end, when present.
 * @returns The saved file metadata and Studio identity.
 * @rejects A stable Studio or save error.
 */
// eslint-disable-next-line flawless/max-lines-per-function -- Keeps the original save proof across transport loss.
export async function saveStudioAsync(
	seams: StudioSeams,
	target: StudioTarget,
	timeoutMs: number = STUDIO_SAVE_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<StudioSave> {
	const started = seams.clock.now();
	const pinned = await pinSaveStudioAsync(seams, target);

	const before = writableMtime(seams, target.place);

	try {
		try {
			await requestStudioSaveAsync(seams, pinned, target.place, {
				deadline: started + timeoutMs,
				signal,
			});
		} catch (err) {
			if (!isHelperChannelLoss(err)) {
				throw err;
			}

			try {
				return await waitForSaveAsync(seams, pinned, target, {
					before,
					signal,
					started,
					timeoutMs,
				});
			} catch {
				throw new ForgeError(
					"save_failed",
					"The Studio save result is unknown. Check the place before saving again.",
					{ cause: err, details: { place: target.place, reason: "unknown" } },
				);
			}
		}

		return await waitForSaveAsync(seams, pinned, target, {
			before,
			signal,
			started,
			timeoutMs,
		});
	} catch (err) {
		throw err instanceof ForgeError ? err : saveFailure(target.place, "studio_error", err);
	}
}

function saveFailure(
	place: string,
	reason: "permission_denied" | "studio_error" | Exclude<SaveOutcome, "requested">,
	cause?: unknown,
): ForgeError {
	return new ForgeError("save_failed", `Could not save ${place}: ${reason}.`, {
		cause,
		details: { place, reason },
	});
}

async function restoreFocusAsync(
	seams: StudioSeams,
	pinned: PinnedStudio,
	{ front, wasHidden }: { front: null | number; wasHidden: boolean },
): Promise<void> {
	if (wasHidden) {
		await pinned.setAppHiddenAsync(true);
	}

	// Activating Studio itself would unhide it again.
	if (front !== null && front !== pinned.pid) {
		const previous = await seams.studioHost.pinProcessAsync(front);
		await previous?.activateAppAsync();
	}
}

/**
 * Make a never-active macOS Studio active until Save to File enables, then
 * restore its hidden state and the previously frontmost app.
 * @param seams - Time and the native addon.
 * @param pinned - The Studio to activate and hide again.
 * @param place - Its place, for the error.
 * @param options - The save deadline and the session end.
 * @rejects `save_failed`: `menu_disabled` when the item stays disabled for
 *   {@link PRIME_LIMIT_MS}, `timeout` when the save deadline passes first.
 */
async function primeStudioAsync(
	seams: StudioSeams,
	pinned: PinnedStudio,
	place: string,
	{ deadline, signal }: { deadline: number; signal: AbortSignal | undefined },
): Promise<void> {
	const front = await seams.studioHost.frontmostApplicationAsync();
	const wasHidden = (await pinned.appHiddenAsync()) === true;
	const primeDeadline = Math.min(deadline, seams.clock.now() + PRIME_LIMIT_MS);
	try {
		for (;;) {
			// The keep-hidden watcher may hide Studio before it is active.
			if ((await pinned.appActiveAsync()) !== true) {
				await pinned.activateAppAsync();
			}

			const remainingMs = deadline - seams.clock.now();
			if (remainingMs <= 0) {
				throw saveFailure(place, "timeout");
			}

			if (await pinned.saveMenuEnabledAsync(remainingMs)) {
				return;
			}

			signal?.throwIfAborted();
			const primeMs = primeDeadline - seams.clock.now();
			if (primeMs <= 0) {
				throw saveFailure(place, "menu_disabled");
			}

			await seams.clock.sleep(Math.min(PRIME_POLL_MS, primeMs), signal);
		}
	} finally {
		await restoreFocusAsync(seams, pinned, { front, wasHidden });
	}
}

async function requestStudioSaveAsync(
	seams: StudioSeams,
	pinned: PinnedStudio,
	place: string,
	{ deadline, signal }: { deadline: number; signal: AbortSignal | undefined },
): Promise<void> {
	signal?.throwIfAborted();
	if (seams.clock.now() >= deadline) {
		throw saveFailure(place, "timeout");
	}

	await dismissLightingDialogAsync(pinned, deadline - seams.clock.now());
	signal?.throwIfAborted();
	const remainingMs = deadline - seams.clock.now();
	if (remainingMs <= 0) {
		throw saveFailure(place, "timeout");
	}

	if (await pinned.isBlockedAsync()) {
		throw new ForgeError("studio_busy", "A modal dialog blocks Roblox Studio.");
	}

	let outcome = await pinned.requestSaveAsync(remainingMs);
	if (outcome === "menu_disabled") {
		await primeStudioAsync(seams, pinned, place, { deadline, signal });
		const primedMs = deadline - seams.clock.now();
		if (primedMs <= 0) {
			throw saveFailure(place, "timeout");
		}

		outcome = await pinned.requestSaveAsync(primedMs);
	}

	if (outcome !== "requested") {
		throw saveFailure(place, outcome);
	}
}

async function savedResultAsync(
	target: StudioTarget,
	pinned: PinnedStudio,
	stat: Stats,
	durationMs: number,
): Promise<StudioSave> {
	return {
		bytes: stat.size,
		desktop: await pinned.desktopAsync(),
		durationMs,
		method: "menu",
		mtime: stat.mtime.toISOString(),
		pid: pinned.pid,
		place: target.place,
		warnings: [],
	};
}

async function waitForSaveAsync(
	seams: StudioSeams,
	pinned: PinnedStudio,
	target: StudioTarget,
	options: {
		before: number;
		signal: AbortSignal | undefined;
		started: number;
		timeoutMs: number;
	},
): Promise<StudioSave> {
	let last = options.before;
	let changedAt = options.started;
	for (;;) {
		options.signal?.throwIfAborted();
		if (!(await pinned.isAliveAsync()) || (await pinned.isBlockedAsync())) {
			throw saveFailure(target.place, "studio_error");
		}

		const now = seams.clock.now();
		const stat = seams.fileSystem.statSync(target.place);
		if (stat.mtimeMs !== last) {
			last = stat.mtimeMs;
			changedAt = now;
		}

		if (last !== options.before && now - changedAt >= STABLE_MS) {
			return savedResultAsync(target, pinned, stat, now - options.started);
		}

		if (now - options.started >= options.timeoutMs) {
			throw saveFailure(target.place, "timeout");
		}

		await seams.clock.sleep(
			Math.min(POLL_MS, options.timeoutMs - (now - options.started)),
			options.signal,
		);
	}
}

function writableMtime({ fileSystem }: StudioSeams, place: string): number {
	let before;
	try {
		before = fileSystem.statSync(place);
		// A writable open checks ACLs on Windows without changing the file.
		const descriptor = fileSystem.openSync(place, "r+");
		fileSystem.closeSync(descriptor);
		if ((before.mode & 0o222) === 0) {
			throw new Error("The place is read-only.");
		}

		return before.mtimeMs;
	} catch (err) {
		throw saveFailure(place, "permission_denied", err);
	}
}

async function pinSaveStudioAsync(seams: StudioSeams, target: StudioTarget): Promise<PinnedStudio> {
	const process = await findPlaceStudioAsync(seams, target.place);
	if (
		process === undefined ||
		(target.process !== undefined &&
			(target.process.pid !== process.pid || target.process.startTime !== process.startTime))
	) {
		throw new ForgeError(
			"studio_not_open",
			`Roblox Studio does not have ${target.place} open.`,
		);
	}

	const pinned = await seams.studioHost.pinProcessAsync(process.pid);
	if (
		pinned === null ||
		!(await pinned.isAliveAsync()) ||
		pinned.startTime !== process.startTime
	) {
		throw new ForgeError(
			"studio_not_open",
			`Roblox Studio does not have ${target.place} open.`,
		);
	}

	return pinned;
}
