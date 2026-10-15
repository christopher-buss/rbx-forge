import { type } from "arktype";
import type { Type } from "arktype";

import type { Reporter } from "../seams/reporter.ts";
import type { CaptureWarning } from "./protocol.ts";

/** Warning metadata accepted from the plugin and session IPC. */
export const captureWarnings: Type<Array<CaptureWarning>> = type({
	property: "string > 0",
	reason: "'collision_groups' | 'material_override' | 'unreadable'",
	service: "string > 0",
}).array();

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
