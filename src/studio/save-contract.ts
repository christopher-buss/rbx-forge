import { type } from "arktype";
import type { Type } from "arktype";

import { ForgeError } from "../errors.ts";
import { STUDIO_SAVE_TIMEOUT_MS } from "./save-studio.ts";
import type { StudioSave } from "./save-studio.ts";

/** Save metadata shared by direct saves and session responses. */
export const studioSaveResult: Type<StudioSave> = type({
	bytes: "number",
	desktop: "'user' | 'hidden'",
	durationMs: "number",
	mtime: "string",
	pid: "number",
	place: "string",
});

/**
 * Resolve the save deadline from a command's seconds flag.
 * @param value - The supplied timeout, or undefined for the default.
 * @returns A positive, finite deadline in milliseconds.
 * @throws A usage error when the deadline is invalid.
 */
export function saveTimeoutMs(value: unknown): number {
	const timeoutMs = value === undefined ? STUDIO_SAVE_TIMEOUT_MS : Number(value) * 1000;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new ForgeError("usage", "--timeout must be a positive number of seconds.");
	}

	return timeoutMs;
}
