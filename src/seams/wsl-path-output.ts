// cspell:words wslpath
import { ForgeError } from "../errors.ts";
import type { ProcessOutcome } from "../process/process-runner.ts";

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
