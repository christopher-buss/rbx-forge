import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { onTestFinished } from "vitest";

import type { PinnedStudio } from "../../src/seams/studio-host.ts";
import { parseStatus } from "../../src/session/status.ts";
import { realStudioHost } from "./real-studio-host.ts";

/**
 * Register ownership before launch so a failed CLI still leaves bounded
 * cleanup.
 *
 * @param project - The owned session root, when launch may fail before returning its pin.
 * @returns Pins only a launcher result or the owned session's Studio.
 */
export function studioCleanup(
	project?: string,
): (studio: { pid: number; startTime: string }) => Promise<PinnedStudio> {
	let pinned: null | PinnedStudio = null;
	onTestFinished(async () => {
		pinned ??= project === undefined ? null : await sessionStudioPinAsync(project);
		await pinned?.killAsync();
		await pinned?.waitForExitAsync(10_000);
	});
	return async ({ pid, startTime }) => {
		const candidate = await realStudioHost().pinProcessAsync(pid, startTime);
		assert(candidate?.startTime === startTime);
		pinned = candidate;
		return candidate;
	};
}

async function sessionStudioPinAsync(project: string): Promise<null | PinnedStudio> {
	const current = path.join(project, ".forge/current");
	if (!existsSync(current)) {
		return null;
	}

	const state = path.join(
		project,
		".forge/sessions",
		readFileSync(current, "utf8").trim(),
		"state.json",
	);
	if (!existsSync(state)) {
		return null;
	}

	const studio = parseStatus(JSON.parse(readFileSync(state, "utf8")))?.services.studio;
	if (studio?.pid === undefined || studio.startTime === undefined) {
		return null;
	}

	return realStudioHost().pinProcessAsync(studio.pid, studio.startTime);
}
