import type { PinnedProcess } from "../native/addon.ts";
import type { StudioSeams, StudioTarget } from "./close-studio.ts";
import { findPlaceStudio } from "./close-studio.ts";
import { studioProcess } from "./launcher.ts";

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
	pinned: PinnedProcess,
	timeoutMs = 1000,
): Promise<boolean> {
	return (
		studioProcess(pinned).desktop === "hidden" &&
		(await pinned.dismissDialog(
			"Lighting Technology Migration",
			"Continue",
			pinned.desktop(),
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
			const pinned = pinLightingStudio(seams, target);
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
			// Accessibility providers can fail while Studio is still loading.
			trace?.({ event: "error", message: String(err) });
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
	pinned: PinnedProcess,
	trace: ((event: LightingWatchEvent) => void) | undefined,
): Promise<boolean> {
	if (studioProcess(pinned).desktop !== "hidden") {
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

function pinLightingStudio(seams: StudioSeams, target: StudioTarget): null | PinnedProcess {
	const studio = findPlaceStudio(seams, target.place);
	if (
		studio === undefined ||
		(target.process !== undefined &&
			(studio.pid !== target.process.pid || studio.startTime !== target.process.startTime))
	) {
		return null;
	}

	const pinned = seams.native().pinProcess(studio.pid);
	return pinned?.startTime === studio.startTime ? pinned : null;
}
