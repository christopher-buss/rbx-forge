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
// eslint-disable-next-line flawless/max-lines-per-function -- Records the three Studio state transitions together.
export function createStudioRecorder(
	status: SessionStatus,
	changed: () => void,
): Pick<StatusRecorder, "studio" | "studioControl" | "studioLeft"> {
	return {
		studio: (studioStatus, place, process, origin = status.services.studio.origin) => {
			const { control, owner } = status.services.studio;
			const from = origin === undefined ? {} : { origin };
			const desktop = process?.desktop ?? "user";
			status.services.studio = {
				...process,
				...(control === undefined ? {} : { control }),
				...from,
				desktop,
				owner,
				place,
				status: studioStatus,
			};
			changed();
		},
		studioControl: (control, isLaunchUnknown) => {
			if (isLaunchUnknown === true) {
				status.services.studio.isLaunchUnknown = true;
			}

			status.services.studio.control = control;
			changed();
		},
		studioLeft: () => {
			const { isLaunchUnknown } = status.services.studio;
			status.services.studio = {
				owner: null,
				status: "off",
				...(isLaunchUnknown === undefined ? {} : { isLaunchUnknown }),
			};
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
	delete part.failure;
	delete part.outputTail;
	Object.assign(part, next);
}
