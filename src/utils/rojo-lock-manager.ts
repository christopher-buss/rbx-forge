import { log } from "@clack/prompts";

import ansis from "ansis";
import fs from "node:fs/promises";

import type { ResolvedConfig } from "../config/schema";
import { ROJO_LOCKFILE_SUFFIX } from "../constants";
import { cleanupLockfile, getLockFilePath, readLockfileRaw } from "./lockfile";
import { isPortAvailable } from "./port-utils";
import { isProcessAlive, killProcess } from "./process-utils";

export interface RojoLockData {
	pid: number;
	port: number;
	startTime: number;
}

/**
 * Removes the Rojo lock file for the given configuration.
 *
 * @param config - The resolved project configuration.
 */
export async function cleanupRojoLock(config: ResolvedConfig): Promise<void> {
	const lockPath = getRojoLockFilePath(config);
	await cleanupLockfile(lockPath);
}

/**
 * Helper to construct Rojo lock file path from config.
 *
 * @param config - The resolved project configuration.
 * @returns Absolute path to the Rojo lock file.
 */
export function getRojoLockFilePath(config: ResolvedConfig): string {
	return getLockFilePath(config, ROJO_LOCKFILE_SUFFIX);
}

/**
 * Reads and parses a Rojo lock file, validating that the process is still
 * running.
 *
 * @param lockPath - Path to the Rojo lock file.
 * @returns Lock data if the file exists and process is alive, null otherwise.
 */
export async function readRojoLock(lockPath: string): Promise<null | RojoLockData> {
	const lines = await readLockfileRaw(lockPath);

	if (lines === null) {
		return null;
	}

	const pid = Number.parseInt(lines[0] ?? "", 10);
	const port = Number.parseInt(lines[1] ?? "", 10);
	const startTime = Number.parseInt(lines[2] ?? "", 10);

	if (Number.isNaN(pid) || Number.isNaN(port) || Number.isNaN(startTime)) {
		// Invalid lockfile, clean it up
		await cleanupLockfile(lockPath);
		return null;
	}

	// Check if process is still running
	const isRunning = await isProcessAlive(pid);
	if (!isRunning) {
		log.warn(`Cleaned up stale Rojo lockfile (PID ${pid} no longer running)`);
		await cleanupLockfile(lockPath);
		return null;
	}

	// Guard against PID reuse: if the recorded port is free, the lock is stale.
	if (await isPortAvailable(port)) {
		log.warn(`Cleaned up stale Rojo lockfile (port ${port} is no longer bound to Rojo)`);
		await cleanupLockfile(lockPath);
		return null;
	}

	return { pid, port, startTime };
}

/**
 * Stops an existing Rojo process for the given place file if one is running.
 *
 * @param config - The resolved project configuration.
 * @returns True if a Rojo process was stopped, false otherwise.
 */
export async function stopExistingRojo(config: ResolvedConfig): Promise<boolean> {
	const lockPath = getRojoLockFilePath(config);
	const lockData = await readRojoLock(lockPath);

	if (lockData === null) {
		return false;
	}

	log.info(
		`Stopping existing Rojo server for ${ansis.cyan(config.buildOutputPath)} ` +
			`(PID ${lockData.pid}, port ${lockData.port})`,
	);

	try {
		await killProcess(lockData.pid);
		await cleanupLockfile(lockPath);
		return true;
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		log.warn(`Failed to kill Rojo process ${lockData.pid}: ${errorMessage}`);
		await cleanupLockfile(lockPath);
		return false;
	}
}

/**
 * Writes a Rojo lock file with the given process information.
 *
 * @param config - The resolved project configuration.
 * @param pid - Process ID of the Rojo server.
 * @param port - Port number the Rojo server is using.
 */
export async function writeRojoLock(
	config: ResolvedConfig,
	pid: number,
	port: number,
): Promise<void> {
	const lockPath = getRojoLockFilePath(config);
	const startTime = Date.now();
	const contents = `${pid}\n${port}\n${startTime}`;

	try {
		await fs.writeFile(lockPath, contents, "utf-8");
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		log.warn(`Failed to write Rojo lockfile: ${errorMessage}`);
	}
}
