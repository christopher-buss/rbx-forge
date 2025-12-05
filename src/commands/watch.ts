import ansis from "ansis";
import process from "node:process";
import { getRojoCommand } from "src/utils/rojo";

import { loadProjectConfig } from "../config";
import { isGracefulShutdown } from "../utils/graceful-shutdown";
import { logger } from "../utils/logger";
import { findAvailablePort } from "../utils/port-utils";
import { setupSignalHandlers } from "../utils/process-manager";
import { cleanupRojoLock, stopExistingRojo, writeRojoLock } from "../utils/rojo-lock-manager";
import { RunError, runStreaming, type StreamingRunResult } from "../utils/run";

export const COMMAND = "watch";
export const DESCRIPTION = "Watch and rebuild on file changes";

interface ProcessHandle extends StreamingRunResult {
	name: string;
}

interface StartProcessOptions {
	args: ReadonlyArray<string>;
	command: string;
	name: string;
}

interface WatchConfig {
	args: ReadonlyArray<string>;
	command: string;
}

interface WatchProcessOptions {
	config: Awaited<ReturnType<typeof loadProjectConfig>>;
	rojo: string;
	rojoPort: number;
	watchArgs: ReadonlyArray<string>;
	watchCommand: string;
}

export async function action(): Promise<void> {
	setupSignalHandlers();

	const config = await loadProjectConfig();
	const rojo = getRojoCommand(config);

	await stopExistingRojo(config);

	const rojoPort = await findAvailablePort();

	const { args: watchArgs, command: watchCommand } = getWatchConfig(config);

	displayStartInfo(rojo, watchCommand, watchArgs, rojoPort);

	await runWatchProcesses({
		config,
		rojo,
		rojoPort,
		watchArgs,
		watchCommand,
	});
}

function displayStartInfo(
	rojo: string,
	watchCommand: string,
	watchArgs: ReadonlyArray<string>,
	rojoPort: number,
): void {
	logger.info(ansis.bold("Starting watch mode"));
	const rojoCommand = `${rojo} serve --port ${rojoPort}`;
	const watchFullCommand = `${watchCommand} ${watchArgs.join(" ")}`;
	logger.step(`Rojo: ${ansis.cyan(rojoCommand)}`);
	logger.step(`Watch: ${ansis.cyan(watchFullCommand)}`);
}

function getWatchConfig(config: Awaited<ReturnType<typeof loadProjectConfig>>): WatchConfig {
	if (config.projectType === "rbxts") {
		return {
			args: [...config.rbxts.args, "-w"],
			command: config.rbxts.command,
		};
	}

	const luauCommand = config.luau.watch.command;
	if (!luauCommand) {
		logger.error(
			"No watch command configured for Luau project.\n" +
				`Add a watch configuration to your rbx-forge.config.ts:\n${ansis.dim(
					'  luau: {\n    watch: { command: "darklua", args: ["process", "--watch"] }\n  }',
				)}`,
		);
		process.exit(1);
	}

	return {
		args: config.luau.watch.args,
		command: luauCommand,
	};
}

async function handleProcessExit(err: unknown): Promise<void> {
	if (isGracefulShutdown(err)) {
		process.exit(0);
	}

	logProcessError(err);
	process.exit(1);
}

function logProcessError(err: unknown): void {
	if (err instanceof RunError) {
		logger.error(`Command failed: ${err.command} ${err.args.join(" ")}`);

		if (err.stderr.length > 0) {
			logger.error("stderr:");
			logger.error(err.stderr);
		}

		if (err.stdout.length > 0) {
			logger.error("stdout:");
			logger.error(err.stdout);
		}

		logger.error(`Exit code: ${err.exitCode}`);
	} else {
		const errorMessage = err instanceof Error ? err.message : String(err);
		logger.error(`Watch process failed: ${errorMessage}`);
	}
}

async function runWatchProcesses(options: WatchProcessOptions): Promise<void> {
	await spawnAndMonitorProcesses(options);
}

async function spawnAndMonitorProcesses(options: WatchProcessOptions): Promise<void> {
	const { config, rojo, rojoPort, watchArgs, watchCommand } = options;

	const rojoArgs = ["serve", "--port", String(rojoPort)];
	if (config.rojoProjectPath.length > 0) {
		rojoArgs.push(config.rojoProjectPath);
	}

	const rojoHandle = startProcess({
		args: rojoArgs,
		command: rojo,
		name: "Rojo Server",
	});

	await writeRojoLock(config, rojoHandle.process.pid, rojoPort);

	const watchHandle = startProcess({
		args: watchArgs,
		command: watchCommand,
		name: config.projectType === "rbxts" ? "TypeScript Compiler" : "Watch Process",
	});

	try {
		await Promise.race([rojoHandle.exitCode, watchHandle.exitCode]);

		logger.error("A watch process exited unexpectedly");
		await cleanupRojoLock(config);
		process.exit(1);
	} catch (err) {
		await cleanupRojoLock(config);
		await handleProcessExit(err);
	}
}

function startProcess(options: StartProcessOptions): ProcessHandle {
	const { args, command, name } = options;

	const result = runStreaming(command, args, {
		shouldRegisterProcess: true,
		shouldShowCommand: false,
	});

	logger.info(`Started ${name}`);

	return {
		...result,
		name,
	};
}
