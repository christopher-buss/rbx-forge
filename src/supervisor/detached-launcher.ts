import assert from "node:assert/strict";
import path from "node:path";

import { ForgeError } from "../errors.ts";
import type { DetachedSpawn, NativeLoader } from "../native/addon.ts";
import { logFilePath } from "../output/log-file.ts";
import type { ChildProcessRunner } from "../seams/child-process.ts";
import type { FileSystem } from "../seams/file-system.ts";
import type { Host } from "../seams/host.ts";
import type { Environment } from "../seams/seams.ts";
import type { SessionRequest } from "./channel.ts";
import { encodeSessionRequest } from "./channel.ts";

/** What one detached launch varies by. */
export interface DetachedLaunch {
	/** The project root: the supervisor's working directory. */
	cwd: string;
	/** The supervisor's environment. */
	env: Environment;
	request: SessionRequest;
}

/**
 * Starts a supervisor that outlives its caller, for `forge up`.
 *
 * @returns The supervisor's PID.
 * @throws {ForgeError} `detach_unsupported` when the host's job forbids
 *   breakaway (Windows).
 */
export type DetachedLauncher = (launch: DetachedLaunch) => number;

/** What the detached launcher starts processes with. */
export interface DetachedBackend {
	childProcess: ChildProcessRunner;
	fileSystem: Pick<FileSystem, "closeSync" | "mkdirSync" | "openSync">;
	host: Pick<Host, "execPath" | "platform">;
	native: NativeLoader;
}

/**
 * Libuv threads the supervisor keeps: the Windows control pipe blocks one
 * per pending accept and read, besides file I/O.
 */
const SUPERVISOR_THREADS = "16";

/** A spawn whose output always goes to the supervisor log. */
type Launch = DetachedSpawn & { output: string };

/**
 * Make the launcher for `forge up` (ADR 0001, "Detach"). It runs `entry`
 * (the built `supervisor.mjs`) with the current Node executable, with no
 * owner pipe: stdin is empty, and stdout and stderr append to
 * `.forge/logs/supervisor.log`, so a crash leaves its trace there.
 *
 * - Windows: through the native addon, with
 *   `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB`,
 *   so the supervisor leaves the terminal's job. A job that forbids
 *   breakaway gives `detach_unsupported`; there is no retry without it.
 * - POSIX: in a new session (`setsid`), so the terminal's hangup never
 *   reaches it.
 *
 * @param backend - The spawn seams, file system, host, and native addon.
 * @param entry - Path of the supervisor entry script.
 * @returns Starts one supervisor per call.
 */
export function createDetachedLauncher(backend: DetachedBackend, entry: string): DetachedLauncher {
	return ({ cwd, env, request }) => {
		const output = logFilePath(cwd, "supervisor");
		backend.fileSystem.mkdirSync(path.dirname(output), { recursive: true });
		const spawn: Launch = {
			args: [entry, encodeSessionRequest(request)],
			cwd,
			env: { UV_THREADPOOL_SIZE: SUPERVISOR_THREADS, ...definedOnly(env) },
			output,
			program: backend.host.execPath,
		};
		return backend.host.platform === "win32"
			? breakAway(backend, spawn)
			: startSession(backend, spawn);
	};
}

function detachUnsupported(): ForgeError {
	return new ForgeError(
		"detach_unsupported",
		"This terminal runs forge in a job that does not let a process outlive it, so forge up cannot start a session here.",
		{
			hint: 'Run "forge start" in this terminal instead, or run forge up from another terminal.',
		},
	);
}

/**
 * Windows: start the supervisor through the addon, out of this process's
 * job.
 *
 * @param backend - The native addon.
 * @param spawn - What to start.
 * @returns Its PID.
 * @throws {ForgeError} `detach_unsupported` when the job forbids breakaway.
 */
function breakAway(backend: Pick<DetachedBackend, "native">, spawn: DetachedSpawn): number {
	const { spawnDetached } = backend.native();
	assert(spawnDetached !== undefined);
	const pid = spawnDetached(spawn);
	if (pid === null) {
		throw detachUnsupported();
	}

	return pid;
}

function ignore(): void {
	// Reported through the missing PID.
}

/**
 * POSIX: start the supervisor in a new session, its output appended to the
 * log.
 *
 * @param backend - The spawn seam and file system.
 * @param spawn - What to start.
 * @returns Its PID.
 * @throws {ForgeError} `internal_error` when it did not start.
 */
function startSession(
	backend: Pick<DetachedBackend, "childProcess" | "fileSystem">,
	{ args, cwd, env, output, program }: Launch,
): number {
	const log = backend.fileSystem.openSync(output, "a");
	try {
		const child = backend.childProcess.spawn(program, args, {
			cwd,
			detached: true,
			env,
			stdio: ["ignore", log, log],
			windowsHide: true,
		});
		// A failed spawn has no PID; the error below reports it.
		child.on("error", ignore);
		if (child.pid === undefined) {
			throw new ForgeError("internal_error", "The supervisor did not start.", {
				hint: "This is a bug in forge. Please report it.",
			});
		}

		child.unref();
		return child.pid;
	} finally {
		backend.fileSystem.closeSync(log);
	}
}

function definedOnly(environment: Environment): Record<string, string> {
	const defined: Record<string, string> = {};
	for (const [name, value] of Object.entries(environment)) {
		if (value !== undefined) {
			defined[name] = value;
		}
	}

	return defined;
}
