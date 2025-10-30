import { spinner } from "@clack/prompts";

import ansis from "ansis";
import { execa } from "execa";
import process from "node:process";
import { getRojoCommand } from "src/utils/rojo";

import { loadProjectConfig } from "../config";
import { isGracefulShutdown } from "../utils/graceful-shutdown";
import { findAvailablePort } from "../utils/port-utils";
import { processManager, setupSignalHandlers } from "../utils/process-manager";
import { cleanupRojoLock, stopExistingRojo, writeRojoLock } from "../utils/rojo-lock-manager";

export const COMMAND = "serve";
export const DESCRIPTION = "Start the Rojo development server";

export async function action(): Promise<void> {
	setupSignalHandlers();

	const config = await loadProjectConfig();

	await stopExistingRojo(config);

	const port = await findAvailablePort();

	const rojo = getRojoCommand();
	const activeSpinner = spinner();
	activeSpinner.start(`Starting Rojo server on port ${port}...`);

	const subprocess = execa(rojo, ["serve", "--port", String(port)], {
		stderr: "inherit",
		stdout: "inherit",
	});

	processManager.register(subprocess);

	if (subprocess.pid !== undefined) {
		await writeRojoLock(config, subprocess.pid, port);
	}

	try {
		await subprocess;
		activeSpinner.stop(ansis.green(`Rojo server started on port ${port}`));
	} catch (err) {
		activeSpinner.stop("Rojo server stopped");
		await cleanupRojoLock(config);
		await handleProcessExit(err);
	}
}

async function handleProcessExit(err: unknown): Promise<void> {
	// Check if this is a graceful shutdown from ProcessManager
	if (isGracefulShutdown(err)) {
		// Graceful shutdown - exit cleanly with code 0
		process.exit(0);
	}

	// Actual error (not a signal) - re-throw
	throw err;
}
