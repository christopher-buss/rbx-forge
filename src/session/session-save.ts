import { ForgeError } from "../errors.ts";
import { saveStudioAsync } from "../studio/save-studio.ts";
import type { StudioSave } from "../studio/save-studio.ts";
import type { SessionScope } from "./run-session.ts";
import type { SessionStudio } from "./status.ts";
import type { StudioSetup } from "./studio-part.ts";

/**
 * Save the session's Studio once its opening state settles.
 * @param setup - The current Studio, seams, and activity tracker.
 * @param scope - The session end signal.
 * @param timeoutMs - The opening and save deadline.
 * @param requestSignal - Ends an expired request without letting another save race its native action.
 * @returns The saved place metadata.
 * @rejects A stable Studio or save error.
 */
export async function saveSessionStudioAsync(
	setup: Pick<StudioSetup, "context" | "idle" | "status">,
	scope: Pick<SessionScope, "signal">,
	timeoutMs: number,
	requestSignal?: AbortSignal,
): Promise<StudioSave> {
	const signal =
		requestSignal === undefined ? scope.signal : AbortSignal.any([scope.signal, requestSignal]);
	const { seams } = setup.context;
	const started = seams.clock.now();
	setup.idle.activity(started);
	try {
		const studio = await waitForSessionStudioAsync(setup, signal, started + timeoutMs);
		const process =
			studio.pid === undefined || studio.startTime === undefined
				? undefined
				: { pid: studio.pid, startTime: studio.startTime };
		const result = await saveStudioAsync(
			seams,
			{ place: studio.place, process },
			timeoutMs - (seams.clock.now() - started),
			signal,
		);
		return { ...result, durationMs: seams.clock.now() - started };
	} finally {
		setup.idle.activity(seams.clock.now());
	}
}

async function waitForSessionStudioAsync(
	setup: Pick<StudioSetup, "context" | "status">,
	signal: AbortSignal,
	deadline: number,
): Promise<SessionStudio & { place: string }> {
	const { seams } = setup.context;
	for (;;) {
		signal.throwIfAborted();
		const { phase, services } = setup.status.snapshot();
		const { studio } = services;
		if (phase === "stopped" || phase === "stopping") {
			throw new ForgeError("not_running", "The session is stopping.");
		}

		const remaining = deadline - seams.clock.now();
		if (remaining <= 0) {
			throw new ForgeError("save_failed", "Studio did not save before the timeout.", {
				details: { reason: "timeout" },
			});
		}

		if (studio.status === "opening") {
			await seams.clock.sleep(Math.min(100, remaining), signal);
			continue;
		}

		if (studio.status !== "open" || studio.place === undefined) {
			throw new ForgeError("studio_not_open", "No session Studio is open.");
		}

		return { ...studio, place: studio.place };
	}
}
