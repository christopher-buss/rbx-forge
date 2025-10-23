import { log, outro } from "@clack/prompts";

import ansis from "ansis";
import { ExecaError, type ResultPromise } from "execa";
import process from "node:process";
import { getRojoCommand } from "src/utils/rojo";

import { loadProjectConfig } from "../config";
import { addPidToLockfile, removePidFromLockfile } from "../utils/lockfile";
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
	cleanup: (exitCode?: number) => Promise<void>;
	config: Awaited<ReturnType<typeof loadProjectConfig>>;
	handles: Array<ProcessHandle>;
	rojo: string;
	watchArgs: ReadonlyArray<string>;
	watchCommand: string;
}

export async function action(): Promise<void> {
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

function createCleanupHandler(handles: Array<ProcessHandle>) {
	let isCleanupInProgress = false;

	return async (exitCode = 0): Promise<void> => {
		if (isCleanupInProgress) {
			return;
		}

		isCleanupInProgress = true;

		log.info(ansis.dim("Stopping watch processes..."));

		for (const handle of handles) {
			try {
				handle.subprocess.kill("SIGTERM");
				handle.taskLogger.success(`${handle.name} stopped`);
			} catch (err) {
				// Process may have already exited or be unresponsive
				// Log the failure but continue cleanup of other processes
				const errorMessage = err instanceof Error ? err.message : "Unknown error";
				handle.taskLogger.error(`Failed to stop ${handle.name}: ${errorMessage}`);
			}
		}

		await removePidFromLockfile(process.pid);

		if (exitCode === 0) {
			outro(ansis.green("Watch stopped successfully"));
		} else {
			outro(ansis.red("Watch stopped with errors"));
		}

		process.exit(exitCode);
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
	const handles: Array<ProcessHandle> = [];
	const cleanup = createCleanupHandler(handles);

	// Handle Ctrl+C
	process.on("SIGINT", () => {
		void cleanup(0);
	});

	await spawnAndMonitorProcesses({
		cleanup,
		config,
		handles,
		rojo,
		watchArgs,
		watchCommand,
	});
}

async function spawnAndMonitorProcesses(options: WatchProcessOptions): Promise<void> {
	const { cleanup, config, handles, rojo, watchArgs, watchCommand } = options;
	try {
		const rojoHandle = await startProcess({
			args: ["serve"],
			command: rojo,
			name: "Rojo Server",
		});
		handles.push(rojoHandle);

		const watchHandle = await startProcess({
			args: watchArgs,
			command: watchCommand,
			name: config.projectType === "rbxts" ? "TypeScript Compiler" : "Watch Process",
		});
		handles.push(watchHandle);

		await addPidToLockfile(process.pid);

		// Wait for either process to exit (fail-fast)
		await Promise.race(handles.map(async (handle) => handle.subprocess));

		log.error("A watch process exited unexpectedly");
		await cleanup(1);
	} catch (err) {
		logProcessError(err);
		await cleanup(1);
	}
}

async function startProcess(options: StartProcessOptions): Promise<ProcessHandle> {
	const { args, command, name } = options;

	const result = runWithTaskLog(command, args, {
		taskName: `${name}...`,
	});

	const wrappedResult = attachErrorHandler(result, name);

	return {
		...wrappedResult,
		name,
	};
}
