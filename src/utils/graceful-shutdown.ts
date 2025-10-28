import type { ExecaError } from "execa";

import { processManager } from "./process-manager";

/**
 * Checks if an error represents a graceful shutdown (SIGTERM/SIGINT).
 *
 * This is used to distinguish between user-initiated interruptions (Ctrl+C) and
 * actual process errors, allowing commands to exit cleanly without logging
 * errors for normal shutdown scenarios.
 *
 * This function checks two conditions:
 *
 * 1. If ProcessManager is currently shutting down (most reliable)
 * 2. If the error has a SIGTERM/SIGINT signal property (fallback).
 *
 * @param err - The error to check.
 * @returns True if error is from graceful shutdown.
 */
export function isGracefulShutdown(err: unknown): boolean {
	// First check if ProcessManager is shutting down
	// This is the most reliable indicator of graceful shutdown
	if (processManager.shuttingDown) {
		return true;
	}

	// Fallback: check if error has signal property
	if (!(err instanceof Error) || !("signal" in err)) {
		return false;
	}

	const execaErr = err as ExecaError;
	return execaErr.signal === "SIGTERM" || execaErr.signal === "SIGINT";
}
