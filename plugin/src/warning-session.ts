import { observeCaptureWarnings } from "./capture-warnings";
import type { CaptureWarnings, WarningIo } from "./capture-warnings";

/** The warning lifetime shared by successive Rojo connections. */
export interface WarningSession {
	close: () => void;
	update: (capture: Configuration | undefined) => CaptureWarnings | undefined;
}

/**
 * Retain warnings while the same forge session reconnects.
 * @param createIo - Engine observations for a new session baseline.
 * @returns The active warning collector and lifetime cleanup.
 */
export function createWarningSession(createIo: () => WarningIo): WarningSession {
	let current: undefined | { id: string; warnings: CaptureWarnings };
	return {
		close: () => {
			current?.warnings.close();
			current = undefined;
		},
		update: (capture) => {
			if (capture === undefined) {
				current?.warnings.close();
				return;
			}

			const id = capture.GetAttribute("ForgeSessionId") ?? capture.GetAttribute("SessionId");
			assert(typeIs(id, "string") && id !== "");
			if (current?.id !== id) {
				current?.warnings.close();
				current = { id, warnings: observeCaptureWarnings(createIo()) };
			} else {
				current.warnings.resume();
			}

			return current.warnings;
		},
	};
}
