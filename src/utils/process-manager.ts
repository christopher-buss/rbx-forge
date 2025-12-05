import process from "node:process";
import { setTimeout } from "node:timers/promises";

import { killProcessTree } from "./kill-process-tree";

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

type Subprocess = ReturnType<typeof Bun.spawn>;

/**
 * Global process lifecycle manager for proper cleanup.
 *
 * Tracks child processes, ensuring they're properly terminated during
 * application shutdown. Supports graceful shutdown with configurable timeouts
 * and force-kill fallback.
 */
export class ProcessManager {
	/** Configuration for shutdown behavior. */
	private readonly config: Required<ProcessManagerConfig> = {
		cleanupTimeout: 5000,
		gracefulShutdownTimeout: 3000,
	};
	private readonly processes = new Set<Subprocess>();

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
	 * Register a Bun subprocess for tracking and cleanup.
	 *
	 * @param subprocess - The Bun subprocess to register.
	 */
	public register(subprocess: Subprocess): void {
		if (this.isShuttingDown) {
			console.warn("ProcessManager is shutting down, cannot register new process");
			return;
		}

		this.processes.add(subprocess);

		// Auto-unregister when process exits
		void subprocess.exited.then(() => {
			this.processes.delete(subprocess);
		});
	}

	/**
	 * Check if ProcessManager is currently shutting down.
	 *
	 * @returns True if shutdown is in progress.
	 */
	public get shuttingDown(): boolean {
		return this.isShuttingDown;
	}

	/**
	 * Unregister a subprocess from tracking.
	 *
	 * @param subprocess - The subprocess to unregister.
	 */
	public unregister(subprocess: Subprocess): void {
		this.processes.delete(subprocess);
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
			await this.forceKillRemainingProcesses();
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

		for (const subprocess of this.processes) {
			if (!subprocess.killed && subprocess.exitCode === null) {
				promises.push(this.terminateProcess(subprocess));
			}
		}

		return promises;
	}

	/**
	 * Force kills a process tree that didn't terminate gracefully.
	 *
	 * @param subprocess - The process to force kill.
	 */
	private async forceKillProcess(subprocess: Subprocess): Promise<void> {
		if (subprocess.killed) {
			return;
		}

		console.warn(`Force killing process ${subprocess.pid}`);
		try {
			await killProcessTree(subprocess.pid, "SIGKILL");
		} catch {
			// Process might already be dead
		}
	}

	/** Force kills any remaining process trees that didn't terminate gracefully. */
	private async forceKillRemainingProcesses(): Promise<void> {
		const killPromises: Array<Promise<void>> = [];

		for (const subprocess of this.processes) {
			if (subprocess.killed || subprocess.exitCode !== null) {
				continue;
			}

			console.warn(`Force killing unresponsive process ${subprocess.pid}`);
			killPromises.push(
				killProcessTree(subprocess.pid, "SIGKILL").catch(() => {
					// Process might already be dead
				}),
			);
		}

		await Promise.all(killPromises);
	}

	/**
	 * Performs the actual cleanup of all tracked resources.
	 *
	 * @returns A promise that resolves when cleanup is complete.
	 */
	private async performCleanup(): Promise<void> {
		await this.cleanupProcesses();
	}

	/**
	 * Terminates a single subprocess gracefully.
	 *
	 * @param subprocess - The process to terminate.
	 * @returns Promise that resolves when the process exits.
	 */
	private async terminateProcess(subprocess: Subprocess): Promise<void> {
		if (subprocess.killed || subprocess.exitCode !== null) {
			return;
		}

		// Try graceful termination first
		try {
			await killProcessTree(subprocess.pid, "SIGTERM");
		} catch {
			// Process might already be dead
		}

		// Wait for process to exit or timeout
		const exitPromise = subprocess.exited;
		const timeoutPromise = setTimeout(this.config.gracefulShutdownTimeout).then(
			() => "timeout",
		);

		const result = await Promise.race([exitPromise, timeoutPromise]);

		if (result === "timeout") {
			await this.forceKillProcess(subprocess);
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
		const timeoutPromise = setTimeout(timeoutMs).then(() => {
			throw new Error(`Operation timed out after ${timeoutMs}ms`);
		});

		return Promise.race([promise, timeoutPromise]);
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
			void processManager.cleanup();
		});
	}
}

export { setupSignalHandlers };
