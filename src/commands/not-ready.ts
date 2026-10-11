import { ForgeError } from "../errors.ts";
import type { SessionStatus } from "../session/status.ts";

/**
 * The error of a session that answers, but has a part that did not become
 * ready in time.
 *
 * @param services - The session's parts.
 * @param waitedMs - How long the caller waited.
 * @returns `compile_timeout` for the compiler, `service_failed` for Rojo,
 *   else `studio_launch_failed`.
 */
export function notReadyError(services: SessionStatus["services"], waitedMs: number): ForgeError {
	const within = `was not ready within ${waitedMs / 1000} s.`;
	if (services.compiler.status === "starting") {
		return new ForgeError("compile_timeout", `The compiler ${within}`, {
			hint: 'Read its output with "forge logs compiler".',
		});
	}

	if (services.rojo.status === "starting") {
		return new ForgeError("service_failed", `Rojo ${within}`, {
			hint: 'Read its output with "forge logs rojo".',
		});
	}

	return new ForgeError("studio_launch_failed", `Studio ${within}`, {
		hint: 'Check "forge status" and Studio\'s Rojo connection.',
	});
}
