import nodeChildProcess from "node:child_process";

/**
 * How forge starts processes before the native reaper owns them. Every call
 * passes `windowsHide: true` and runs Node-based tools with the current Node
 * executable (no `.bin` shims). Unit tests pass a fake `spawn`; real processes
 * run only in the integration and e2e projects.
 */
export type ChildProcessRunner = Pick<typeof nodeChildProcess, "spawn">;

export const nodeChildProcessRunner: ChildProcessRunner = nodeChildProcess;
