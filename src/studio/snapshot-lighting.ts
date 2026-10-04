import { type } from "arktype";

import type { Seams } from "../seams/seams.ts";
import { STUDIO_OPEN_BOUND_MS } from "../session/studio-readiness.ts";
import { watchHiddenLightingAsync } from "./lighting-dialog.ts";

const watchTarget = type({ pid: "number.integer > 0", place: "string", startTime: "string > 0" });

/**
 * Watch one exact snapshot Studio until its migration prompt, exit, or deadline.
 * @param seams - The place lock, native process identity, and polling clock.
 * @param payload - The launched place and PID/start-time identity as JSON.
 */
export async function runSnapshotLightingAsync(seams: Seams, payload: string): Promise<void> {
	const { pid, place, startTime } = watchTarget.assert(JSON.parse(payload));
	const pinned = seams.native().pinProcess(pid);
	if (pinned === null || pinned.startTime !== startTime || !pinned.isAlive()) {
		return;
	}

	const abort = new AbortController();
	await watchHiddenLightingAsync(
		{
			...seams,
			clock: {
				...seams.clock,
				sleep: async (ms, signal) => {
					await seams.clock.sleep(ms, signal);
					if (!pinned.isAlive()) {
						abort.abort();
					}
				},
			},
		},
		{ place, process: { pid, startTime } },
		{ openingTimeoutMs: STUDIO_OPEN_BOUND_MS, signal: abort.signal },
	);
}
