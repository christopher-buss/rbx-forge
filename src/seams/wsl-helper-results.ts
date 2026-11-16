// cspell:words wslpath
import { type } from "arktype";

import type { StudioDesktop } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import type { ProcessOutcome } from "../process/process-runner.ts";
import type { StudioLaunchOutcome } from "../studio/launcher.ts";

const pinShape = type({
	pid: "number.integer > 0",
	pin: "string > 0",
	startTime: "string > 0",
});

const WINDOWS_PATH_END = /\r?\n?$/;

/**
 * Validate a wslpath result and trim its Windows line ending.
 * @param result - Converter process result.
 * @param input - Path for the diagnostic.
 * @returns Converted path text.
 * @rejects A failed converter.
 */
export function convertedOutput(result: ProcessOutcome, input: string): string {
	if (result.type !== "exited" || result.exitCode !== 0) {
		throw new ForgeError(
			"studio_launch_failed",
			`wslpath could not convert ${input} to an absolute path.`,
		);
	}

	return result.outputTail.join("\n").replace(WINDOWS_PATH_END, "");
}

/**
 * Decode a completed Windows launch without assuming an uncertain PID.
 * @param value - Helper reply.
 * @param desktop - The requested Studio placement.
 * @returns The launched Studio identity.
 * @rejects An unusable launch identity.
 */
export function launched(value: unknown, desktop: StudioDesktop): StudioLaunchOutcome {
	const pinned = pinShape.assert(value);
	return {
		desktop,
		studio: { desktop, os: "win32", pid: pinned.pid, startTime: pinned.startTime },
		type: "launched",
	};
}

/**
 * Decode a helper pin identity.
 * @param value - Helper reply.
 * @returns The pinned Windows identity.
 * @rejects A malformed identity.
 */
export function pinnedIdentity(value: unknown): { pid: number; pin: string; startTime: string } {
	return pinShape.assert(value);
}

// oxlint-disable-next-line typescript/require-await -- The async Studio seam rejects unsupported capabilities.
export async function unsupportedAsync(): Promise<never> {
	throw new ForgeError(
		"windows_helper_unavailable",
		"This Studio operation is not supported by the Windows helper tracer.",
	);
}
