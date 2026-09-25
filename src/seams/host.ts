import os from "node:os";
import process from "node:process";

/**
 * Facts about the forge process and the OS it runs on, plus the one signal
 * call forge makes. Unit tests pass a fake, so each OS path runs on every OS.
 */
export interface Host {
	/** When the OS booted, in milliseconds since the Unix epoch. */
	bootTimeMs: () => number;
	/** The current Node executable: runs Node-based tools (no `.bin` shims). */
	execPath: string;
	/** This computer's name. */
	hostname: string;
	/**
	 * Send `signal` to a process, or to a process group with a negative pid.
	 */
	kill: (pid: number, signal: NodeJS.Signals) => void;
	platform: NodeJS.Platform;
}

export const nodeHost: Host = {
	bootTimeMs: () => Date.now() - os.uptime() * 1000,
	execPath: process.execPath,
	hostname: os.hostname(),
	kill: (pid, signal) => {
		process.kill(pid, signal);
	},
	platform: process.platform,
};
