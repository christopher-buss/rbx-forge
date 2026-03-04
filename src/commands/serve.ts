import { log, outro } from "@clack/prompts";

import ansis from "ansis";
import process from "node:process";
import type { ResolvedConfig } from "src/config/schema";
import { getRojoCommand } from "src/utils/rojo";
import { runWithTaskLog } from "src/utils/run";

import { loadProjectConfig } from "../config";
import { isGracefulShutdown } from "../utils/graceful-shutdown";
import { findAvailablePort } from "../utils/port-utils";
import { setupSignalHandlers } from "../utils/process-manager";
import { cleanupRojoLock, stopExistingRojo, writeRojoLock } from "../utils/rojo-lock-manager";

export const COMMAND = "serve";
export const DESCRIPTION = "Start the Rojo development server";

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

	try {
		await startRojoServer(commandOptions, config, port);
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
): Promise<void> {
	const rojo = getRojoCommand(config);

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

	log.info(`Rojo serve running on port ${port}\n`);

	// Fix Windows issue: clack doesn't restore raw mode on Windows
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(false);
	}

	await subprocess;
}
