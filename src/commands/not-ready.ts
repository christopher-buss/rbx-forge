import { ForgeError } from "../errors.ts";
import type { ServiceId, SessionStatus } from "../session/status.ts";

const SERVICES: ReadonlyArray<ServiceId> = ["compiler", "rojo"];
const NAMES: Readonly<Record<ServiceId, string>> = { compiler: "The compiler", rojo: "Rojo" };

/**
 * Say that something did not become ready in time.
 *
 * @param what - Such as `The session`.
 * @param waitedMs - How long the caller waited.
 * @returns Such as `The session was not ready within 300 s.`.
 */
export function notReadyMessage(what: string, waitedMs: number): string {
	return `${what} was not ready within ${waitedMs / 1000} s.`;
}

/**
 * The error of a session that does not answer, or is not ready in time.
 *
 * @param what - What went wrong.
 * @returns `supervisor_unresponsive`.
 */
export function unresponsive(what: string): ForgeError {
	return new ForgeError("supervisor_unresponsive", what, {
		hint: 'Check "forge logs start" and "forge status", or stop the session and try again.',
	});
}

/**
 * The error of a session that answers, but has a part that did not become
 * ready in time.
 *
 * @param services - The session's parts; `undefined` when it does not answer.
 * @param waitedMs - How long the caller waited.
 * @returns `compile_timeout` for a compiler that is starting,
 *   `service_failed` for Rojo, `studio_launch_failed` for a Studio that is
 *   opening; else `undefined`.
 */
export function notReadyError(
	services: SessionStatus["services"] | undefined,
	waitedMs: number,
): ForgeError | undefined {
	if (services === undefined) {
		return undefined;
	}

	if (services.compiler.status === "starting") {
		return new ForgeError("compile_timeout", notReadyMessage(NAMES.compiler, waitedMs), {
			hint: readLogs("compiler"),
		});
	}

	if (services.rojo.status === "starting") {
		return new ForgeError("service_failed", notReadyMessage(NAMES.rojo, waitedMs), {
			hint: readLogs("rojo"),
		});
	}

	if (services.studio.status === "opening") {
		return new ForgeError("studio_launch_failed", notReadyMessage("Studio", waitedMs), {
			hint: 'Check "forge status" and Studio\'s Rojo connection.',
		});
	}

	return undefined;
}

/**
 * The error of a service part the caller waited for that forge stopped as
 * failed. A part whose service exited by itself is no error.
 *
 * @param services - The session's parts.
 * @param waited - The parts the caller saw starting.
 * @returns `compile_timeout` for the compiler, `service_failed` for Rojo;
 *   `undefined` when forge failed none of them.
 */
export function failedError(
	services: SessionStatus["services"],
	waited: ReadonlySet<ServiceId>,
): ForgeError | undefined {
	const id = SERVICES.find((part) => {
		return (
			waited.has(part) &&
			services[part].status === "failed" &&
			services[part].failure !== undefined
		);
	});
	if (id === undefined) {
		return undefined;
	}

	// Forge fails the compiler only for its first-build bound.
	const code = id === "compiler" ? "compile_timeout" : "service_failed";
	return new ForgeError(code, `${services[id].failure}.`, { hint: readLogs(id) });
}

/**
 * Note the service parts that are starting, and fail when one the caller
 * saw starting failed.
 *
 * @param waited - The parts the caller saw starting; notes the new ones.
 * @param services - The session's parts.
 * @throws {ForgeError} As {@link failedError}.
 */
export function noteWaited(waited: Set<ServiceId>, services: SessionStatus["services"]): void {
	const failed = failedError(services, waited);
	if (failed !== undefined) {
		throw failed;
	}

	for (const id of SERVICES) {
		if (services[id].status === "starting") {
			waited.add(id);
		}
	}
}

function readLogs(id: ServiceId): string {
	return `Read its output with "forge logs ${id}".`;
}
