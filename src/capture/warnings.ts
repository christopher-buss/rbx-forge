import { type } from "arktype";
import type { Type } from "arktype";

import { ForgeError, toForgeError } from "../errors.ts";
import type { Reporter } from "../seams/reporter.ts";
import type { CaptureWarning } from "./protocol.ts";

/** Warning metadata accepted from the plugin and session IPC. */
export const captureWarnings: Type<Array<CaptureWarning>> = type({
	property: "string > 0",
	reason: "'collision_groups' | 'material_override' | 'unreadable'",
	service: "string > 0",
}).array();

/**
 * Keep warnings received from Studio when a later capture step fails.
 * @param err - The original failure.
 * @param warnings - Warnings already consumed by this capture.
 * @returns The failure with transportable warning metadata.
 */
export function withCaptureWarnings(err: unknown, warnings: Array<CaptureWarning>): unknown {
	if (warnings.length === 0) {
		return err;
	}

	const failure = toForgeError(err);
	return new ForgeError(failure.code, failure.message, {
		cause: failure.cause,
		details: { ...failure.details, captureWarnings: warnings },
		hint: failure.hint,
	});
}

/**
 * Name each property that cannot sync in human and structured output.
 * @param reporter - The command's output seam.
 * @param warnings - Warnings returned by this capture.
 */
export function emitCaptureWarnings(reporter: Reporter, warnings: Array<CaptureWarning>): void {
	for (const warning of warnings) {
		reporter.emit({
			...warning,
			message: `${warning.service}.${warning.property} cannot be captured; set it in the project file.`,
			type: "warning",
		});
	}
}

/**
 * Report warnings carried by a failed capture before its command fails.
 * @param reporter - The command's output seam.
 * @param err - The capture or session failure.
 */
export function emitCaptureFailureWarnings(reporter: Reporter, err: unknown): void {
	const warnings = captureWarnings(toForgeError(err).details?.["captureWarnings"]);
	if (!(warnings instanceof type.errors)) {
		emitCaptureWarnings(reporter, warnings);
	}
}
