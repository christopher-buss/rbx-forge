import { log } from "@clack/prompts";

import ansis from "ansis";
import { ExecaError, type ResultPromise } from "execa";
import process from "node:process";
import { getRojoCommand } from "src/utils/rojo";

import { loadProjectConfig } from "../config";
import { addPidToLockfile, removePidFromLockfile } from "../utils/lockfile";
import { processManager, setupSignalHandlers } from "../utils/process-manager";
import { runWithTaskLog, type TaskLogResult } from "../utils/run";

export const COMMAND = "watch";
export const DESCRIPTION = "Watch and rebuild on file changes";

interface ProcessHandle extends TaskLogResult {
	/** Process name for logging. */
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
	watchArgs: ReadonlyArray<string>;
	watchCommand: string;
}

export async function action(): Promise<void> {
	setupSignalHandlers();

	const config = await loadProjectConfig();
	const rojo = getRojoCommand();

	const { args: watchArgs, command: watchCommand } = getWatchConfig(config);

	displayStartInfo(rojo, watchCommand, watchArgs);

	await runWatchProcesses(rojo, watchCommand, watchArgs, config);
}

function attachErrorHandler(result: TaskLogResult, name: string): TaskLogResult {
	const wrappedSubprocess = result.subprocess.catch((err: unknown) => {
		if (!(err instanceof Error)) {
			throw err;
		}

		if (err instanceof ExecaError) {
			result.taskLogger.error(`${name} failed with exit code ${err.exitCode ?? "unknown"}`);

			logErrorOutput(result.taskLogger, String(err.stderr));
			logErrorOutput(result.taskLogger, String(err.stdout));
		} else {
			result.taskLogger.error(`${name} failed: ${err.message}`);
		}

		throw err;
	}) as ResultPromise;

	return {
		subprocess: wrappedSubprocess,
		taskLogger: result.taskLogger,
	};
}

function displayStartInfo(
	rojo: string,
	watchCommand: string,
	watchArgs: ReadonlyArray<string>,
): void {
	log.info(ansis.bold("→ Starting watch mode"));
	const rojoCommand = `${rojo} serve`;
	const watchFullCommand = `${watchCommand} ${watchArgs.join(" ")}`;
	log.step(`Rojo: ${ansis.cyan(rojoCommand)}`);
	log.step(`Watch: ${ansis.cyan(watchFullCommand)}`);
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
		// cspell:ignore darklua
		log.error(
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

/**
 * Handle process exit - either expected (graceful shutdown) or unexpected
 * error.
 *
 * @param err - The error that caused the process to exit.
 * @param cleanupHook - The cleanup hook to unregister if needed.
 */
async function handleProcessExit(err: unknown, cleanupHook: () => Promise<void>): Promise<void> {
	// Check if this is a graceful shutdown from ProcessManager
	if (isGracefulShutdown(err)) {
		// Graceful shutdown - DON'T unregister hook
		// ProcessManager's signal handler will run the hook
		return;
	}

	// Actual error (not a signal) - unregister and cleanup manually
	processManager.unregisterCleanupHook(cleanupHook);
	logProcessError(err);
	await removePidFromLockfile(process.pid);
	process.exit(1);
}

/**
 * Check if an error is from a graceful shutdown (ProcessManager
 * SIGTERM/SIGINT).
 *
 * @param err - The error to check.
 * @returns True if error is from graceful shutdown.
 */
function isGracefulShutdown(err: unknown): boolean {
	if (!(err instanceof ExecaError)) {
		return false;
	}

	return err.signal === "SIGTERM" || err.signal === "SIGINT";
}

function logErrorOutput(
	taskLogger: ReturnType<typeof import("@clack/prompts").taskLog>,
	output: string,
): void {
	if (output.length === 0 || output === "undefined") {
		return;
	}

	const lines = output.trim().split("\n");
	for (const line of lines) {
		taskLogger.error(line);
	}
}

function logProcessError(err: unknown): void {
	if (err instanceof ExecaError) {
		log.error(`Command failed: ${err.command}`);

		const stderr = String(err.stderr);
		if (stderr.length > 0) {
			log.error("stderr:");
			log.error(stderr);
		}

		const stdout = String(err.stdout);
		if (stdout.length > 0) {
			log.error("stdout:");
			log.error(stdout);
		}

		if (err.exitCode !== undefined) {
			log.error(`Exit code: ${err.exitCode}`);
		}
	} else {
		const errorMessage = err instanceof Error ? err.message : String(err);
		log.error(`Watch process failed: ${errorMessage}`);
	}
}

async function runWatchProcesses(
	rojo: string,
	watchCommand: string,
	watchArgs: ReadonlyArray<string>,
	config: Awaited<ReturnType<typeof loadProjectConfig>>,
): Promise<void> {
	await spawnAndMonitorProcesses({
		config,
		rojo,
		watchArgs,
		watchCommand,
	});
}

async function spawnAndMonitorProcesses(options: WatchProcessOptions): Promise<void> {
	const { config, rojo, watchArgs, watchCommand } = options;

	const rojoHandle = await startProcess({
		args: ["serve"],
		command: rojo,
		name: "Rojo Server",
	});

	const watchHandle = await startProcess({
		args: watchArgs,
		command: watchCommand,
		name: config.projectType === "rbxts" ? "TypeScript Compiler" : "Watch Process",
	});

	await addPidToLockfile(process.pid);

	async function cleanupHook(): Promise<void> {
		await removePidFromLockfile(process.pid);
	}

	processManager.registerCleanupHook(cleanupHook);

	try {
		await Promise.race([rojoHandle.subprocess, watchHandle.subprocess]);

		// Process exited unexpectedly - unregister hook and clean up
		processManager.unregisterCleanupHook(cleanupHook);
		log.error("A watch process exited unexpectedly");
		await removePidFromLockfile(process.pid);
		process.exit(1);
	} catch (err) {
		await handleProcessExit(err, cleanupHook);
	}
}

async function startProcess(options: StartProcessOptions): Promise<ProcessHandle> {
	const { args, command, name } = options;

	const result = runWithTaskLog(command, args, {
		shouldRegisterProcess: true,
		taskName: `${name}...`,
	});

	const wrappedResult = attachErrorHandler(result, name);

	return {
		...wrappedResult,
		name,
	};
}
