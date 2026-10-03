import type { PartFailure, ServicePart, SessionStatus, StatusRecorder } from "./status.ts";

/**
 * The service half of a recorder.
 *
 * @param status - The status it changes.
 * @param changed - Called after each change.
 * @returns What records a service's part.
 */
export function createPartRecorder(
	status: SessionStatus,
	changed: () => void,
): Pick<StatusRecorder, "owner" | "rojoPort" | "service" | "serviceFailed"> {
	return {
		owner: (part, owner) => {
			status.services[part].owner = owner;
			changed();
		},
		rojoPort: (port) => {
			status.services.rojo.port = port;
			changed();
		},
		service: (id, partStatus) => {
			setPart(status.services[id], { status: partStatus });
			changed();
		},
		serviceFailed: (id, failure) => {
			setPart(status.services[id], { ...failure, status: "failed" });
			changed();
		},
	};
}

/**
 * The Studio half of a recorder.
 *
 * @param status - The status it changes.
 * @param changed - Called after each change.
 * @returns What records the session's Studio.
 */
export function createStudioRecorder(
	status: SessionStatus,
	changed: () => void,
): Pick<StatusRecorder, "studio" | "studioLeft"> {
	return {
		studio: (studioStatus, place, process, origin = status.services.studio.origin) => {
			const { owner } = status.services.studio;
			const from = origin === undefined ? {} : { origin };
			status.services.studio = { ...process, ...from, owner, place, status: studioStatus };
			changed();
		},
		studioLeft: () => {
			status.services.studio = { owner: null, status: "off" };
			changed();
		},
	};
}

/**
 * Set a part's status; a failure's fields stay only with `failed`.
 *
 * @param part - The part, changed in place.
 * @param next - Its new status, and the failure for `failed`.
 */
function setPart(
	part: ServicePart,
	next: Partial<PartFailure> & Pick<ServicePart, "status">,
): void {
	delete part.exitCode;
	delete part.outputTail;
	Object.assign(part, next);
}
