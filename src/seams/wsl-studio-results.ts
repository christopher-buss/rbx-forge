// cspell:words wslpath
import type { Type } from "arktype";
import { type } from "arktype";

import type { StudioDesktop } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import type { ProcessOutcome } from "../process/process-runner.ts";
import type { StudioLaunchOutcome } from "../studio/launcher.ts";

export const pinShape: Type<{ pid: number; pin: string; startTime: string }> = type({
	pid: "number.integer > 0",
	pin: "string > 0",
	startTime: "string > 0",
});

const WINDOWS_PATH_END = /\r?\n?$/;

export function launched(value: unknown, desktop: StudioDesktop): StudioLaunchOutcome {
	if (!pinShape.allows(value)) {
		throw new ForgeError(
			"studio_launch_unknown",
			"The Windows helper returned no usable Studio launch identity. Check Studio before trying again.",
		);
	}

	const pinned = value;
	return {
		desktop,
		studio: { desktop, os: "win32", pid: pinned.pid, startTime: pinned.startTime },
		type: "launched",
	};
}

// oxlint-disable-next-line typescript/require-await -- The async Studio seam rejects unsupported capabilities.
export async function unsupportedAsync(): Promise<never> {
	throw new ForgeError(
		"windows_helper_unavailable",
		"This Studio operation is not supported by the Windows helper tracer.",
	);
}

export function convertedOutput(result: ProcessOutcome, input: string): string {
	if (result.type !== "exited" || result.exitCode !== 0) {
		throw new ForgeError(
			"studio_launch_failed",
			`wslpath could not convert ${input} to an absolute path.`,
		);
	}

	return result.outputTail.join("\n").replace(WINDOWS_PATH_END, "");
}
