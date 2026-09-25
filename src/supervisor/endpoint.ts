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
 *   from `XDG_RUNTIME_DIR`, then `TMPDIR`, then `/tmp`.
 */
export function endpointFor(input: EndpointInput): string {
	const key = endpointKey(input.projectRoot, input.buildOutputPath);
	if (input.platform === "win32") {
		return `\\\\.\\pipe\\rbx-forge-${key}`;
	}

	const runtime = input.env["XDG_RUNTIME_DIR"] ?? input.env["TMPDIR"] ?? "/tmp";
	return path.posix.join(runtime, `rbx-forge-${String(input.userId)}-${key}`, "ctl.sock");
}
