import type { Reporter } from "../seams/reporter.ts";
import type { StudioControl, StudioHost } from "../seams/studio-host.ts";

/**
 * Observe the process-local channel and report its availability transitions.
 * @param host - Studio control on this side.
 * @param reporter - The current command or session event stream.
 * @param record - Also records availability in a session, when present.
 * @returns The subscription disposer, absent on native hosts.
 */
export function observeStudioControl(
	host: StudioHost,
	reporter: Reporter,
	record?: (state: StudioControl) => void,
): (() => void) | undefined {
	let previous: StudioControl | undefined;
	return host.onControl?.((control) => {
		record?.(control);
		if (control === "recovering") {
			reporter.emit({
				message: "Windows Studio control was lost; recovering.",
				type: "warning",
			});
		} else if (control === "unavailable") {
			reporter.emit({
				message: "Windows Studio control is unavailable; recovery stopped.",
				type: "warning",
			});
		} else if (previous === "recovering") {
			reporter.emit({ message: "Windows Studio control recovered.", type: "info" });
		}

		previous = control;
	});
}
