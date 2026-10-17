import { type } from "arktype";

import type { Seams } from "../seams/seams.ts";
import { STUDIO_OPEN_BOUND_MS } from "../session/studio-readiness.ts";
import type { LightingWatchEvent } from "./lighting-dialog.ts";
import { watchHiddenLightingAsync } from "./lighting-dialog.ts";

const watchTarget = type({ pid: "number.integer > 0", place: "string", startTime: "string > 0" });

type SnapshotLightingEvent =
	| LightingWatchEvent
	| { event: "identity-rejected" | "studio-exited" }
	| { event: "start"; pid: number; place: string; startTime: string };

/**
 * Watch one exact snapshot Studio until its migration prompt, exit, or deadline.
 * @param seams - The place lock, native process identity, and polling clock.
 * @param payload - The launched place and PID/start-time identity as JSON.
 * @param traceFile - Optional diagnostic event log; writing it never ends the watch.
 */
export async function runSnapshotLightingAsync(
	seams: Seams,
	payload: string,
	traceFile?: string,
): Promise<void> {
	const { pid, place, startTime } = watchTarget.assert(JSON.parse(payload));
	const trace = createLightingTrace(seams, traceFile);
	trace({ event: "start", pid, place, startTime });
	const pinned = seams.native().pinProcess(pid);
	if (pinned === null || pinned.startTime !== startTime || !pinned.isAlive()) {
		trace({ event: "identity-rejected" });
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
						trace({ event: "studio-exited" });
						abort.abort();
					}
				},
			},
		},
		{ place, process: { pid, startTime } },
		{ openingTimeoutMs: STUDIO_OPEN_BOUND_MS, signal: abort.signal, trace },
	);
}

function createLightingTrace(
	seams: Pick<Seams, "clock" | "fileSystem">,
	traceFile: string | undefined,
): (event: SnapshotLightingEvent) => void {
	return (event) => {
		if (traceFile === undefined) {
			return;
		}

		try {
			seams.fileSystem.writeFileSync(
				traceFile,
				`${JSON.stringify({ at: seams.clock.now(), ...event })}\n`,
				{ flag: "a" },
			);
		} catch {
			// Diagnostics never change the watcher's lifetime.
		}
	};
}
