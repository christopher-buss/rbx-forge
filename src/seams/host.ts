import process from "node:process";

/**
 * Facts about the forge process and the OS it runs on, plus the one signal
 * call forge makes. Unit tests pass a fake, so each OS path runs on every OS.
 */
export interface Host {
	/** The current Node executable: runs Node-based tools (no `.bin` shims). */
	execPath: string;
	/**
	 * Send `signal` to a process, or to a process group with a negative pid.
	 */
	kill: (pid: number, signal: NodeJS.Signals) => void;
	platform: NodeJS.Platform;
}

export const nodeHost: Host = {
	execPath: process.execPath,
	kill: (pid, signal) => {
		process.kill(pid, signal);
	},
	platform: process.platform,
};
