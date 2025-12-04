import { stdin } from "node:process";
import type { ResolvedConfig } from "src/config/schema";
import { getRojoCommand } from "src/utils/rojo";
import { runStreaming, type StreamingRunResult } from "src/utils/run";
import yoctoSpinner from "yocto-spinner";

import { loadProjectConfig } from "../config";
import { isGracefulShutdown } from "../utils/graceful-shutdown";
import { logger } from "../utils/logger";
import { findAvailablePort } from "../utils/port-utils";
import { setupSignalHandlers } from "../utils/process-manager";
import { cleanupRojoLock, stopExistingRojo, writeRojoLock } from "../utils/rojo-lock-manager";

export const COMMAND = "serve";
export const DESCRIPTION = "Start the Rojo development server";

interface RojoServerResult extends StreamingRunResult {
	port: number;
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
		await result.exitCode;
	} catch (err) {
		await handleProcessExit(err);
	} finally {
		await cleanupRojoLock(config);
	}

	if (Bun.env["RBX_FORGE_CMD"] === "serve") {
		logger.success("Rojo server has successfully stopped.");
	}
}

async function handleProcessExit(err: unknown): Promise<void> {
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
	const spinner = yoctoSpinner({ text: `Starting Rojo server on port ${port}...` }).start();

	const args = ["serve", "--port", String(port)];

	const projectPath = commandOptions.project ?? config.rojoProjectPath;
	if (projectPath.length > 0) {
		args.push(projectPath);
	}

	const result = runStreaming(rojo, args, {
		shouldRegisterProcess: true,
		shouldShowCommand: false,
	});

	const subprocessPid = result.process.pid;
	await writeRojoLock(config, subprocessPid, port);

	spinner.success(`Rojo serve running on port ${port}`);

	// Fix Windows issue: clack doesn't restore raw mode on Windows
	if (stdin.isTTY) {
		stdin.setRawMode(false);
	}

	return { ...result, port };
}
