import type { ChildProcess } from "node:child_process";
import process from "node:process";

/** Configuration options for ProcessManager. */
interface ProcessManagerConfig {
	/**
	 * Maximum time in milliseconds to wait for all processes to terminate.
	 *
	 * @default 5000
	 */
	cleanupTimeout?: number;

	/**
	 * Time in milliseconds to wait for SIGTERM before sending SIGKILL.
	 *
	 * @default 3000
	 */
	gracefulShutdownTimeout?: number;
}

/**
 * Global process lifecycle manager for proper cleanup.
 *
 * Tracks child processes, ensuring they're properly terminated during
 * application shutdown. Supports graceful shutdown with configurable timeouts
 * and force-kill fallback.
 */
export class ProcessManager {
	private readonly cleanupHooks = new Set<() => Promise<void> | void>();
	/** Configuration for shutdown behavior. */
	private readonly config: Required<ProcessManagerConfig> = {
		cleanupTimeout: 5000,
		gracefulShutdownTimeout: 3000,
	};
	private readonly exitListeners = new WeakMap<ChildProcess, () => void>();
	private readonly processes = new Set<ChildProcess>();

	private cleanupPromise: null | Promise<void> = null;
	private isShuttingDown = false;

	/**
	 * Cleanup all tracked resources.
	 *
	 * @returns A promise that resolves when cleanup is complete.
	 */
	public async cleanup(): Promise<void> {
		if (this.cleanupPromise) {
			return this.cleanupPromise;
		}

		this.isShuttingDown = true;

		this.cleanupPromise = this.performCleanup();
		return this.cleanupPromise;
	}

	/**
	 * Configure the ProcessManager behavior.
	 *
	 * @param config - Partial configuration to apply.
	 */
	public configure(config: ProcessManagerConfig): void {
		if (config.gracefulShutdownTimeout !== undefined) {
			this.config.gracefulShutdownTimeout = config.gracefulShutdownTimeout;
		}

		if (config.cleanupTimeout !== undefined) {
			this.config.cleanupTimeout = config.cleanupTimeout;
		}
	}

	/**
	 * Register a child process for tracking and cleanup.
	 *
	 * Processes registered here will be gracefully terminated (SIGTERM, then
	 * SIGKILL after timeout) during application shutdown. On Windows, the
	 * process will be killed immediately as signals are not supported.
	 *
	 * @param childProcess - The child process to register.
	 */
	public register(childProcess: ChildProcess): void {
		if (this.isShuttingDown) {
			console.warn("ProcessManager is shutting down, cannot register new process");
			return;
		}

		this.processes.add(childProcess);

		/** Store the listener so we can remove it later. */
		const exitListener = (): void => {
			this.unregister(childProcess);
		};

		this.exitListeners.set(childProcess, exitListener);
		childProcess.on("exit", exitListener);
	}

	/**
	 * Register a cleanup hook that runs during ProcessManager cleanup.
	 *
	 * Hooks run before processes are terminated, allowing commands to perform
	 * cleanup tasks (like removing lock files) before the process exits.
	 *
	 * @param hook - Async or sync function to run during cleanup.
	 */
	public registerCleanupHook(hook: () => Promise<void> | void): void {
		this.cleanupHooks.add(hook);
	}

	/**
	 * Unregister a child process from tracking.
	 *
	 * Use this when you want to manually remove a process from tracking without
	 * waiting for it to exit.
	 *
	 * @param childProcess - The child process to unregister.
	 */
	public unregister(childProcess: ChildProcess): void {
		this.processes.delete(childProcess);

		// Remove the exit listener to prevent memory leaks
		const listener = this.exitListeners.get(childProcess);
		if (listener) {
			childProcess.off("exit", listener);
			this.exitListeners.delete(childProcess);
		}
	}

	/**
	 * Unregister a previously registered cleanup hook.
	 *
	 * @param hook - The hook function to unregister.
	 */
	public unregisterCleanupHook(hook: () => Promise<void> | void): void {
		this.cleanupHooks.delete(hook);
	}

	/** Terminates all registered processes with timeout handling. */
	private async cleanupProcesses(): Promise<void> {
		const processCleanupPromises = this.collectProcessCleanupPromises();

		if (processCleanupPromises.length === 0) {
			return;
		}

		try {
			await this.withTimeout(Promise.all(processCleanupPromises), this.config.cleanupTimeout);
		} catch {
			this.forceKillRemainingProcesses();
		}

		this.processes.clear();
	}

	/**
	 * Collects cleanup promises for all active processes.
	 *
	 * @returns Array of promises for process termination.
	 */
	private collectProcessCleanupPromises(): Array<Promise<void>> {
		const promises: Array<Promise<void>> = [];

		for (const task of this.processes) {
			if (!task.killed && task.exitCode === null) {
				promises.push(this.terminateProcess(task));
			}
		}

		return promises;
	}

	/**
	 * Force kills a process that didn't terminate gracefully.
	 *
	 * @param childProcess - The process to force kill.
	 */
	private forceKillProcess(childProcess: ChildProcess): void {
		if (childProcess.killed) {
			return;
		}

		console.warn(`Force killing process ${childProcess.pid}`);
		try {
			childProcess.kill(process.platform === "win32" ? undefined : "SIGKILL");
		} catch {
			// Process might already be dead
		}
	}

	/** Force kills any remaining processes that didn't terminate gracefully. */
	private forceKillRemainingProcesses(): void {
		for (const proc of this.processes) {
			if (proc.killed || proc.exitCode !== null) {
				continue;
			}

			console.warn(`Force killing unresponsive process ${proc.pid}`);
			try {
				proc.kill(process.platform === "win32" ? undefined : "SIGKILL");
			} catch {
				// Process might already be dead
			}
		}
	}

	/**
	 * Performs the actual cleanup of all tracked resources.
	 *
	 * Runs cleanup hooks first, then terminates processes. Processes that don't
	 * terminate within the cleanup timeout will be force-killed.
	 *
	 * @returns A promise that resolves when cleanup is complete.
	 */
	private async performCleanup(): Promise<void> {
		// Run cleanup hooks first (before killing processes)
		for (const hook of this.cleanupHooks) {
			try {
				await hook();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.warn(`[ProcessManager] Cleanup hook failed: ${message}`);
			}
		}

		await this.cleanupProcesses();
	}

	/**
	 * Terminates a single child process gracefully.
	 *
	 * On Unix-like systems: sends SIGTERM, then SIGKILL after timeout. On
	 * Windows: kills immediately (signals not supported).
	 *
	 * @param childProcess - The process to terminate.
	 * @returns Promise that resolves when the process exits.
	 */
	private async terminateProcess(childProcess: ChildProcess): Promise<void> {
		return new Promise<void>((resolve) => {
			if (childProcess.killed || childProcess.exitCode !== null) {
				resolve();
				return;
			}

			const timeout = setTimeout(() => {
				this.forceKillProcess(childProcess);
				resolve();
			}, this.config.gracefulShutdownTimeout);

			childProcess.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});

			// Try graceful termination first
			if (!this.tryGracefulKill(childProcess)) {
				clearTimeout(timeout);
				resolve();
			}
		});
	}

	/**
	 * Attempts to gracefully kill a process.
	 *
	 * @param childProcess - The process to kill.
	 * @returns True if kill signal was sent, false if process already dead.
	 */
	private tryGracefulKill(childProcess: ChildProcess): boolean {
		try {
			if (process.platform === "win32") {
				// Windows doesn't support SIGTERM, kill immediately
				childProcess.kill();
			} else {
				// Unix-like: try SIGTERM first
				childProcess.kill("SIGTERM");
			}

			return true;
		} catch {
			// Process might already be dead
			return false;
		}
	}

	/**
	 * Wraps a promise with a timeout.
	 *
	 * @param promise - The promise to wrap.
	 * @param timeoutMs - Timeout in milliseconds.
	 * @returns The promise result or throws if timeout is exceeded.
	 */
	private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
		let timeoutHandle: NodeJS.Timeout | undefined;

		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeoutHandle = setTimeout(() => {
				reject(new Error(`Operation timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});

		try {
			return await Promise.race([promise, timeoutPromise]);
		} finally {
			if (timeoutHandle !== undefined) {
				clearTimeout(timeoutHandle);
			}
		}
	}
}

// Global process manager instance
export const processManager = new ProcessManager();

// Track if signal handlers are already setup
// eslint-disable-next-line flawless/naming-convention -- Not a constant
let signalHandlersSetup = false;

/** Setup signal handlers for graceful shutdown. */
function setupSignalHandlers(): void {
	if (signalHandlersSetup) {
		return;
	}

	signalHandlersSetup = true;

	const signals: Array<NodeJS.Signals> = ["SIGINT", "SIGTERM", "SIGQUIT"];

	for (const signal of signals) {
		process.on(signal, () => {
			void (async () => {
				await processManager.cleanup();
				process.exit(0);
			})();
		});
	}

	// Handle uncaught exceptions
	process.on("uncaughtException", (error) => {
		void (async () => {
			console.error("Uncaught exception:", error);
			await processManager.cleanup();
			process.exit(1);
		})();
	});

	// Handle unhandled promise rejections
	process.on("unhandledRejection", (reason, promise) => {
		void (async () => {
			console.error("Unhandled rejection at:", promise, "reason:", reason);
			await processManager.cleanup();
			process.exit(1);
		})();
	});
}

// Export setup function for commands that need it
export { setupSignalHandlers };
