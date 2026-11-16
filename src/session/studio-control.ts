import type { SessionSetup } from "./session-body.ts";

/**
 * Publish control availability without changing Studio or session lifetime.
 * @param session - The session state and event reporter.
 * @param signal - Ends the subscription with the session.
 */
export function watchStudioControl(session: SessionSetup, signal: AbortSignal): void {
	let previous: string | undefined;
	const dispose = session.context.seams.studioHost.onControl?.((control) => {
		session.status.studioControl(control);
		if (control === "recovering") {
			session.context.reporter.emit({
				message: "Windows Studio control was lost; recovering.",
				type: "warning",
			});
		} else if (control === "unavailable") {
			session.context.reporter.emit({
				message: "Windows Studio control is unavailable; recovery stopped.",
				type: "warning",
			});
		} else if (previous === "recovering") {
			session.context.reporter.emit({
				message: "Windows Studio control recovered.",
				type: "info",
			});
		}

		previous = control;
	});
	signal.addEventListener(
		"abort",
		() => {
			dispose?.();
		},
		{ once: true },
	);
}
