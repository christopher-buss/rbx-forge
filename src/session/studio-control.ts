import { observeStudioControl } from "../studio/control-events.ts";
import type { SessionSetup } from "./session-body.ts";

/**
 * Publish control availability without changing Studio or session lifetime.
 * @param session - The session state and event reporter.
 * @param signal - Ends the subscription with the session.
 */
export function watchStudioControl(session: SessionSetup, signal: AbortSignal): void {
	const dispose = observeStudioControl(
		session.context.seams.studioHost,
		session.context.reporter,
		session.status.studioControl,
	);
	if (dispose !== undefined) {
		signal.addEventListener("abort", dispose);
	}
}
