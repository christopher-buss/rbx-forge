import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { onTestFinished } from "vitest";

import type { PinnedProcess } from "../../src/native/addon.ts";
import { parseStatus } from "../../src/session/status.ts";
import { pinNow } from "./worker-log.ts";

/**
 * Register ownership before launch so a failed CLI still leaves bounded
 * cleanup.
 *
 * @param project - The owned session root, when launch may fail before returning its pin.
 * @returns Pins only a launcher result or the owned session's Studio.
 */
export function studioCleanup(
	project?: string,
): (studio: { pid: number; startTime?: string }) => PinnedProcess {
	let pinned: PinnedProcess | undefined;
	onTestFinished(() => {
		pinned ??= project === undefined ? undefined : sessionStudioPin(project);
		pinned?.kill();
		pinned?.waitForExit(10_000);
	});
	return ({ pid, startTime }) => {
		const candidate = pinNow(pid);
		assert(
			candidate !== undefined &&
				(startTime === undefined || candidate.startTime === startTime),
		);
		pinned = candidate;
		return candidate;
	};
}

function sessionStudioPin(project: string): PinnedProcess | undefined {
	const current = path.join(project, ".forge/current");
	if (!existsSync(current)) {
		return undefined;
	}

	const state = path.join(
		project,
		".forge/sessions",
		readFileSync(current, "utf8").trim(),
		"state.json",
	);
	if (!existsSync(state)) {
		return undefined;
	}

	const studio = parseStatus(JSON.parse(readFileSync(state, "utf8")))?.services.studio;
	if (studio?.pid === undefined || studio.startTime === undefined) {
		return undefined;
	}

	const pinned = pinNow(studio.pid);
	return pinned?.startTime === studio.startTime ? pinned : undefined;
}
