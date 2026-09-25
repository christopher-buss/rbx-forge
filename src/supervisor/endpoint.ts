import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";

import type { Environment } from "../seams/seams.ts";

/** What names a session's IPC endpoint. */
export interface EndpointInput {
	/**
	 * The resolved `buildOutputPath`: two builds of one tree are two sessions.
	 */
	buildOutputPath: string;
	env: Environment;
	platform: NodeJS.Platform;
	/** The absolute project root. */
	projectRoot: string;
	/** POSIX: the user id; the socket's directory is per user. */
	userId: number | undefined;
}

/** The longest socket path every POSIX OS takes (`sun_path`, less its NUL). */
export const MAX_SOCKET_PATH = 103;

/** Where a socket goes when the runtime directory is missing or too deep. */
const FALLBACK_RUNTIME = "/tmp";

/** Hex characters of the endpoint key. */
const KEY_LENGTH = 16;

/**
 * The key of a project's endpoint: a hash of its root and build output, so
 * each worktree (and each build of one) has its own.
 *
 * @param projectRoot - The absolute project root.
 * @param buildOutputPath - The resolved build output path.
 * @returns 16 hex characters.
 */
export function endpointKey(projectRoot: string, buildOutputPath: string): string {
	return createHash("sha256")
		.update(`${projectRoot}\0${buildOutputPath}`)
		.digest("hex")
		.slice(0, KEY_LENGTH);
}

/**
 * The IPC endpoint of a project's session (spec #28, IPC): a named pipe on
 * Windows, a Unix socket inside a per-user directory elsewhere. The
 * supervisor records it in the identity record; the IPC server (#43)
 * creates it, with a current-user access list or a 0700 directory.
 *
 * @param input - The project, build output, and host facts.
 * @returns `\\.\pipe\rbx-forge-<key>`, or
 *   `<runtime dir>/rbx-forge-<uid>-<key>/ctl.sock` with the runtime directory
 *   from `XDG_RUNTIME_DIR`, then `TMPDIR`, then `/tmp`. A socket path longer
 *   than {@link MAX_SOCKET_PATH} bytes (the macOS limit is 104 with its
 *   NUL) falls back to `/tmp`.
 */
export function endpointFor(input: EndpointInput): string {
	const key = endpointKey(input.projectRoot, input.buildOutputPath);
	if (input.platform === "win32") {
		return `\\\\.\\pipe\\rbx-forge-${key}`;
	}

	const runtime = input.env["XDG_RUNTIME_DIR"] ?? input.env["TMPDIR"] ?? FALLBACK_RUNTIME;
	const socket = socketPath(runtime, input.userId, key);
	return Buffer.byteLength(socket) > MAX_SOCKET_PATH
		? socketPath(FALLBACK_RUNTIME, input.userId, key)
		: socket;
}

function socketPath(runtime: string, userId: number | undefined, key: string): string {
	return path.posix.join(runtime, `rbx-forge-${String(userId)}-${key}`, "ctl.sock");
}
