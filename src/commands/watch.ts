import { log, outro, taskLog } from "@clack/prompts";

import ansis from "ansis";
import { execa, type ResultPromise } from "execa";
import process from "node:process";
import { createInterface } from "node:readline";

import { loadProjectConfig } from "../config";
import { getRojoCommand } from "../utils/get-rojo-command";

export const COMMAND = "watch";
export const DESCRIPTION = "Watch and rebuild on file changes";

interface ProcessHandle {
	/** Process name for logging. */
	name: string;
	/** Subprocess promise. */
	subprocess: ResultPromise;
	/** Task logger for this process. */
	taskLogger: ReturnType<typeof taskLog>;
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

function attachErrorHandler(
	subprocess: ResultPromise,
	taskLogger: ReturnType<typeof taskLog>,
	name: string,
): ResultPromise {
	return subprocess.catch((err: unknown) => {
		if (!isExecaError(err)) {
			// Re-throw non-execa errors
			throw err;
		}

		taskLogger.error(`${name} failed with exit code ${err.exitCode ?? "unknown"}`);
		const stderr = err.stderr ?? "";
		if (stderr.length > 0) {
			const lines = stderr.trim().split("\n");
			for (const line of lines) {
				taskLogger.error(line);
			}
		}

		// Re-throw to propagate to Promise.race
		throw err;
	}) as ResultPromise;
}

function createCleanupHandler(handles: Array<ProcessHandle>) {
	let isCleanupInProgress = false;

	return async (exitCode = 0): Promise<void> => {
		if (isCleanupInProgress) {
			return;
		}

		isCleanupInProgress = true;

		// Show cleanup message
		log.info(ansis.dim("Stopping watch processes..."));

		for (const handle of handles) {
			try {
				handle.subprocess.kill("SIGTERM");
				handle.taskLogger.success(`${handle.name} stopped`);
			} catch {
				// Ignore errors during cleanup
			}
		}

		// Show completion message
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

	// Luau project
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

function isExecaError(error: unknown): error is Error & {
	command: string;
	exitCode?: number;
	failed: boolean;
	stderr?: string;
	stdout?: string;
} {
	return (
		typeof error === "object" &&
		error !== null &&
		"exitCode" in error &&
		"command" in error &&
		"failed" in error
	);
}

function logExecaError(
	err: Error & { command: string; exitCode?: number; stderr?: string; stdout?: string },
): void {
	log.error(`Command failed: ${err.command}`);

	const stderr = err.stderr ?? "";
	if (stderr.length > 0) {
		log.error("stderr:");
		log.error(stderr);
	}

	const stdout = err.stdout ?? "";
	if (stdout.length > 0) {
		log.error("stdout:");
		log.error(stdout);
	}

	if (err.exitCode !== undefined) {
		log.error(`Exit code: ${err.exitCode}`);
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

	// Handle Ctrl+C gracefully
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
		// Start rojo serve
		const rojoHandle = await startProcess({
			args: ["serve"],
			command: rojo,
			name: "Rojo Server",
		});
		handles.push(rojoHandle);

		// Start watch process
		const watchHandle = await startProcess({
			args: watchArgs,
			command: watchCommand,
			name: config.projectType === "rbxts" ? "TypeScript Compiler" : "Watch Process",
		});
		handles.push(watchHandle);

		// Wait for either process to exit (fail-fast)
		await Promise.race(handles.map(async (handle) => handle.subprocess));

		// If we get here, one process exited - this is unexpected in watch mode
		log.error("A watch process exited unexpectedly");
		await cleanup(1);
	} catch (err) {
		// One of the processes failed - display detailed error info
		if (isExecaError(err)) {
			logExecaError(err);
		} else {
			const errorMessage = err instanceof Error ? err.message : String(err);
			log.error(`Watch process failed: ${errorMessage}`);
		}

		await cleanup(1);
	}
}

async function startProcess(options: StartProcessOptions): Promise<ProcessHandle> {
	const { args, command, name } = options;

	const taskLogger = taskLog({
		limit: 12,
		title: `${name}...`,
	});

	const subprocess = execa(command, args, {
		all: true,
		buffer: false,
	});

	const rl = createInterface({
		crlfDelay: Number.POSITIVE_INFINITY,
		input: subprocess.all,
	});

	rl.on("line", (line) => {
		taskLogger.message(line);
	});

	// Wrap subprocess with error handler that logs and re-throws
	const wrappedSubprocess = attachErrorHandler(subprocess, taskLogger, name);

	return {
		name,
		subprocess: wrappedSubprocess,
		taskLogger,
	};
}
