import { outro, spinner } from "@clack/prompts";

import ansis from "ansis";
import type { ResultPromise } from "execa";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import type { ResolvedConfig } from "src/config/schema";
import { getRojoCommand } from "src/utils/rojo";
import { runWithTaskLog, type Spinner } from "src/utils/run";

import { loadProjectConfig } from "../config";
import { isGracefulShutdown } from "../utils/graceful-shutdown";
import { findAvailablePort } from "../utils/port-utils";
import { setupSignalHandlers } from "../utils/process-manager";
import { cleanupRojoLock, stopExistingRojo, writeRojoLock } from "../utils/rojo-lock-manager";

export const COMMAND = "serve";
export const DESCRIPTION = "Start the Rojo development server";

interface RojoServerResult {
	activeSpinner: Spinner;
	subprocess: ResultPromise;
}

export const options = [
	{
		description: "Path to the project to serve (defaults to current directory)",
		flags: "--project <path>",
	},
] as const;

export interface ServeOptions {
	project?: string;
}

export async function action(commandOptions: ServeOptions = {}): Promise<void> {
	setupSignalHandlers();

	const config = await loadProjectConfig();
	await stopExistingRojo(config);

	const port = await findAvailablePort();
	const result = await startRojoServer(commandOptions, config, port);

	try {
		await waitForServerOrCancellation(result.subprocess, result.activeSpinner);
	} catch (err) {
		await handleProcessExit(err);
	} finally {
		await cleanupRojoLock(config);
	}

	if (process.env["RBX_FORGE_CMD"] === "serve") {
		outro(ansis.green("Rojo server has successfully stopped."));
	}
}

async function handleProcessExit(err: unknown): Promise<void> {
	// Check if this is a graceful shutdown from ProcessManager
	if (!isGracefulShutdown(err)) {
		throw err;
	}
}

async function startRojoServer(
	commandOptions: ServeOptions,
	config: ResolvedConfig,
	port: number,
): Promise<RojoServerResult> {
	const rojo = getRojoCommand(config);
	const activeSpinner = spinner({ cancelMessage: "Cancelling Rojo Serve" });
	activeSpinner.start(`Starting Rojo server on port ${port}...`);

	const args = ["serve", "--port", String(port)];

	const projectPath = commandOptions.project ?? config.rojoProjectPath;
	if (projectPath.length > 0) {
		args.push(projectPath);
	}

	const { subprocess } = runWithTaskLog(rojo, args, {
		shouldRegisterProcess: true,
		taskName: "Rojo Serve",
	});

	const subprocessPid = subprocess.pid;
	if (subprocessPid !== undefined) {
		await writeRojoLock(config, subprocessPid, port);
	}

	activeSpinner.message(`Rojo serve running on port ${port}`);

	// Fix Windows issue: clack doesn't restore raw mode on Windows
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(false);
	}

	return { activeSpinner, subprocess };
}

async function waitForServerOrCancellation(
	subprocess: ResultPromise,
	activeSpinner: Spinner,
): Promise<void> {
	await Promise.race([
		subprocess,
		(async () => {
			const spinnerState = activeSpinner as { isCancelled?: boolean };
			while (spinnerState.isCancelled !== true) {
				await setTimeout(100);
			}
		})(),
	]);
}
