import type { Stats } from "node:fs";

import { ForgeError } from "../errors.ts";
import type { PinnedProcess } from "../native/addon.ts";
import type { StudioSeams, StudioTarget } from "./close-studio.ts";
import { findPlaceStudio } from "./close-studio.ts";

export interface StudioSave {
	bytes: number;
	desktop: "hidden" | "user";
	durationMs: number;
	mtime: string;
	pid: number;
	place: string;
}

export const STUDIO_SAVE_TIMEOUT_MS = 30_000;

const POLL_MS = 100;
const STABLE_MS = 250;

/**
 * Save a verified Studio and wait until its changed place file settles.
 * @param seams - Files, time, and the native addon.
 * @param target - The Studio and its place.
 * @param timeoutMs - The deadline from the start of this save.
 * @param signal - The session end, when present.
 * @returns The saved file metadata and Studio identity.
 * @rejects A stable Studio or save error.
 */
export async function saveStudioAsync(
	seams: StudioSeams,
	target: StudioTarget & { desktop?: "hidden" | "user" },
	timeoutMs: number = STUDIO_SAVE_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<StudioSave> {
	const started = seams.clock.now();
	const pinned = pinSaveStudio(seams, target);

	const before = writableMtime(seams, target.place);

	try {
		if (pinned.isBlocked()) {
			throw new ForgeError("studio_busy", "A modal dialog blocks Roblox Studio.");
		}

		if ((await pinned.requestSave()) === "no_menu_item") {
			throw saveFailure(target.place, "no_menu_item");
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
	reason: "no_menu_item" | "permission_denied" | "studio_error" | "timeout",
	cause?: unknown,
): ForgeError {
	return new ForgeError("save_failed", `Could not save ${place}: ${reason}.`, {
		cause,
		details: { place, reason },
	});
}

function savedResult(
	target: StudioTarget & { desktop?: "hidden" | "user" },
	pinned: PinnedProcess,
	stat: Stats,
	durationMs: number,
): StudioSave {
	return {
		bytes: stat.size,
		desktop: pinned.desktop(),
		durationMs,
		mtime: stat.mtime.toISOString(),
		pid: pinned.pid,
		place: target.place,
	};
}

async function waitForSaveAsync(
	seams: StudioSeams,
	pinned: PinnedProcess,
	target: StudioTarget & { desktop?: "hidden" | "user" },
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
		if (!pinned.isAlive() || pinned.isBlocked()) {
			throw saveFailure(target.place, "studio_error");
		}

		const now = seams.clock.now();
		const stat = seams.fileSystem.statSync(target.place);
		if (stat.mtimeMs !== last) {
			last = stat.mtimeMs;
			changedAt = now;
		}

		if (last !== options.before && now - changedAt >= STABLE_MS) {
			return savedResult(target, pinned, stat, now - options.started);
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

function pinSaveStudio(seams: StudioSeams, target: StudioTarget): PinnedProcess {
	const process = findPlaceStudio(seams, target.place);
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

	const pinned = seams.native().pinProcess(process.pid);
	if (pinned === null || !pinned.isAlive() || pinned.startTime !== process.startTime) {
		throw new ForgeError(
			"studio_not_open",
			`Roblox Studio does not have ${target.place} open.`,
		);
	}

	return pinned;
}
