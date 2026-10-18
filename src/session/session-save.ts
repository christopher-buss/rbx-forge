import { saveCaptureAsync } from "../capture/save.ts";
import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import type { StudioTarget } from "../studio/close-studio.ts";
import { saveStudioAsync } from "../studio/save-studio.ts";
import type { StudioSave } from "../studio/save-studio.ts";
import type { PartHandlers } from "./part-requests.ts";
import type { SessionScope } from "./run-session.ts";
import type { SessionStudio } from "./status.ts";
import type { StudioSetup } from "./studio-part.ts";

type SessionSaveSetup = Partial<Pick<StudioSetup, "config">> &
	Pick<StudioSetup, "capture" | "context" | "idle" | "status">;

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
	setup: SessionSaveSetup,
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
		if (setup.config?.studio.saveMethod === "capture") {
			const result = await captureSessionAsync(
				{ ...setup, config: setup.config },
				studio,
				signal,
				started + timeoutMs,
			);
			return { ...result, durationMs: seams.clock.now() - started };
		}

		const result = await saveStudioAsync(
			seams,
			menuTarget(studio),
			timeoutMs - (seams.clock.now() - started),
			signal,
		);
		return { ...result, durationMs: seams.clock.now() - started };
	} finally {
		setup.idle.activity(seams.clock.now());
	}
}

/**
 * Use the current capture generation and run every base build through the reaper.
 * @param setup - The live session, including later Rojo restarts.
 * @param scope - The session lifetime.
 * @param context - The reaper's step context.
 * @returns The queued session save handler.
 */
export function createSessionSaveHandler(
	setup: SessionSaveSetup,
	scope: Pick<SessionScope, "signal">,
	context: CommandContext,
): NonNullable<PartHandlers["save"]> {
	return async (timeoutMs, signal) => {
		return saveSessionStudioAsync({ ...setup, context }, scope, timeoutMs, signal);
	};
}

function menuTarget({ pid, place, startTime }: SessionStudio & { place: string }): StudioTarget {
	const process = pid === undefined || startTime === undefined ? undefined : { pid, startTime };
	return { place, process };
}

async function captureSessionAsync(
	setup: Pick<StudioSetup, "capture" | "context"> & { config: ResolvedConfig },
	studio: SessionStudio & { place: string },
	signal: AbortSignal,
	deadline: number,
): Promise<StudioSave> {
	if (setup.capture === undefined) {
		throw new ForgeError(
			"capture_not_connected",
			"The forge plugin is not connected; connect Studio to the session's Rojo.",
		);
	}

	return saveCaptureAsync(setup.context, setup.config, {
		deadline,
		listener: setup.capture,
		signal: AbortSignal.any([
			signal,
			AbortSignal.timeout(Math.max(1, deadline - setup.context.seams.clock.now())),
		]),
		studio: { ...studio, desktop: "user" },
	});
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
