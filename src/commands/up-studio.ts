import { ForgeError } from "../errors.ts";
import type { PartRequest } from "../session/part-requests.ts";
import type { SessionStatus } from "../session/status.ts";

/**
 * Classify a Studio attachment that lost its Studio or session.
 * @returns A launch failure rather than success or a supervisor crash.
 */
export function studioCancelled(): ForgeError {
	return new ForgeError(
		"studio_launch_failed",
		"Studio stopped before its attachment was ready.",
		{
			hint: 'Check "forge status" and try "forge up --studio" again.',
		},
	);
}

/**
 * Keep a Studio attachment from succeeding after a concurrent stop.
 * @param status - The latest session status after the add request.
 * @param wanted - The parts selected by this up.
 * @returns Whether the selected Studio is ready.
 * @throws A stopped Studio cannot satisfy its pending attachment.
 */
export function isStudioReady(status: SessionStatus, wanted: PartRequest): boolean {
	if (!wanted.parts.includes("studio") || status.services.studio.status === "open") {
		return true;
	}

	if (status.services.studio.status === "opening") {
		return false;
	}

	throw studioCancelled();
}
