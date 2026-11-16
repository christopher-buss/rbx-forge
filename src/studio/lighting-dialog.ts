import { isHelperChannelLoss } from "../native/helper-client.ts";
import type { PinnedStudio } from "../seams/studio-host.ts";
import type { StudioSeams, StudioTarget } from "./close-studio.ts";
import { findPlaceStudioAsync } from "./close-studio.ts";
import { studioProcessAsync } from "./launcher.ts";

/** Boundaries of a hidden Studio's migration prompt watch. */
export type LightingWatchEvent =
	| { deadline: number; event: "lock" | "opening" }
	| { dismissed: boolean; event: "dismiss-end" }
	| { event: "dismiss-start" }
	| {
			event: "end";
			reason: "cancelled" | "deadline" | "dismissed" | "sleep-failed" | "visible";
	  }
	| { event: "error"; message: string };

/**
 * Dismiss only the hidden Studio Lighting migration prompt.
 * @param pinned - The verified Studio identity.
 * @param timeoutMs - The remaining accessibility deadline.
 * @returns Whether its migration prompt was dismissed.
 */
export async function dismissLightingDialogAsync(
	pinned: PinnedStudio,
	timeoutMs = 1000,
): Promise<boolean> {
	const studio = await studioProcessAsync(pinned);
	return (
		studio.desktop === "hidden" &&
		(await pinned.dismissDialogAsync(
			"Lighting Technology Migration",
			"Continue",
			await pinned.desktopAsync(),
			timeoutMs,
		))
	);
}

/**
 * Follow hidden startup beyond place readiness for the delayed migration prompt.
 * @param seams - The verified lock, native addon, and polling clock.
 * @param target - The launched or attached place and identity.
 * @param options - Opening deadline, cancellation, and optional diagnostic observer.
 */
// eslint-disable-next-line sonar/cognitive-complexity, flawless/max-lines-per-function -- The bounded watcher distinguishes uncertain mutations from transient accessibility errors.
export async function watchHiddenLightingAsync(
	seams: StudioSeams,
	target: StudioTarget,
	{
		openingTimeoutMs,
		signal,
		trace,
	}: {
		openingTimeoutMs: number;
		signal: AbortSignal;
		trace?: (event: LightingWatchEvent) => void;
	},
): Promise<void> {
	let deadline = seams.clock.now() + openingTimeoutMs;
	let hasLock = false;
	trace?.({ deadline, event: "opening" });
	while (!signal.aborted && seams.clock.now() < deadline) {
		try {
			const pinned = await pinLightingStudioAsync(seams, target);
			if (pinned !== null) {
				if (!hasLock) {
					deadline = seams.clock.now() + 30_000;
					hasLock = true;
					trace?.({ deadline, event: "lock" });
				}

				if (await dismissWatchedLightingAsync(pinned, trace)) {
					return;
				}
			}
		} catch (err) {
			trace?.({ event: "error", message: String(err) });
			if (isHelperChannelLoss(err)) {
				return;
			}
		}

		try {
			await seams.clock.sleep(500, signal);
		} catch {
			trace?.({ event: "end", reason: "sleep-failed" });
			return;
		}
	}

	trace?.({ event: "end", reason: signal.aborted ? "cancelled" : "deadline" });
}

async function dismissWatchedLightingAsync(
	pinned: PinnedStudio,
	trace: ((event: LightingWatchEvent) => void) | undefined,
): Promise<boolean> {
	const studio = await studioProcessAsync(pinned);
	if (studio.desktop !== "hidden") {
		trace?.({ event: "end", reason: "visible" });
		return true;
	}

	trace?.({ event: "dismiss-start" });
	const wasDismissed = await dismissLightingDialogAsync(pinned);
	trace?.({ dismissed: wasDismissed, event: "dismiss-end" });
	if (wasDismissed) {
		trace?.({ event: "end", reason: "dismissed" });
	}

	return wasDismissed;
}

async function pinLightingStudioAsync(
	seams: StudioSeams,
	target: StudioTarget,
): Promise<null | PinnedStudio> {
	const studio = await findPlaceStudioAsync(seams, target.place);
	if (
		studio === undefined ||
		(target.process !== undefined &&
			(studio.pid !== target.process.pid || studio.startTime !== target.process.startTime))
	) {
		return null;
	}

	const pinned = await seams.studioHost.pinProcessAsync(studio.pid);
	return pinned?.startTime === studio.startTime ? pinned : null;
}
