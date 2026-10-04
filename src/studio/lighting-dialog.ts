import type { PinnedProcess } from "../native/addon.ts";
import type { StudioSeams, StudioTarget } from "./close-studio.ts";
import { findPlaceStudio } from "./close-studio.ts";

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
		pinned.desktop() === "hidden" &&
		(await pinned.dismissDialog(
			"Lighting Technology Migration",
			"Continue",
			"hidden",
			timeoutMs,
		))
	);
}

/**
 * Follow hidden startup beyond place readiness for the delayed migration prompt.
 * @param seams - The verified lock, native addon, and polling clock.
 * @param target - The launched or attached place and identity.
 * @param options - Opening deadline and the end of the Studio follow.
 */
export async function watchHiddenLightingAsync(
	seams: StudioSeams,
	target: StudioTarget,
	{ openingTimeoutMs, signal }: { openingTimeoutMs: number; signal: AbortSignal },
): Promise<void> {
	let deadline = seams.clock.now() + openingTimeoutMs;
	let hasLock = false;
	while (!signal.aborted && seams.clock.now() < deadline) {
		try {
			const pinned = pinLightingStudio(seams, target);
			if (pinned !== null) {
				if (!hasLock) {
					deadline = seams.clock.now() + 30_000;
					hasLock = true;
				}

				if (pinned.desktop() !== "hidden" || (await dismissLightingDialogAsync(pinned))) {
					return;
				}
			}
		} catch {
			// Accessibility providers can fail while Studio is still loading.
		}

		try {
			await seams.clock.sleep(500, signal);
		} catch {
			return;
		}
	}
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
