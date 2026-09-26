import path from "node:path";

import type { FileSystem } from "../seams/file-system.ts";

/**
 * The session files of a project, under `.forge`.
 *
 * ```text
 * .forge/supervisor.lock               singleton: exclusive lock, held for the supervisor's life
 * .forge/current                       hint: the id of the live session
 * .forge/sessions/<id>/supervisor.id   write-once identity record
 * .forge/sessions/<id>/token           IPC token (0600; Windows: owner-only DACL)
 * .forge/sessions/<id>/state.json      the session's status (`session/status.ts`)
 * .forge/sessions/<id>/workers.lock    lease: the reaper and its workers hold it shared
 * .forge/sessions/<id>/reaper.json     reaper record: written by the reaper only
 * .forge/sessions/<id>/output/         raw worker output while the session runs
 * .forge/logs/<service>.log            rotated service logs (`output/log-file.ts`)
 * .forge/snapshots/<time>_<place>      places `forge open` built (`studio/snapshots.ts`)
 * ```
 *
 * Only the holder of the singleton lock creates or deletes a session
 * directory or rewrites `current`. The lock file and the lease hold no data:
 * Windows blocks reads of a locked file.
 */
export interface ForgeFiles {
	/** `.forge/current`. */
	current: string;
	/** `.forge`. */
	directory: string;
	/** `.forge/supervisor.lock`. */
	lock: string;
	/** `.forge/sessions`. */
	sessions: string;
	/** `.forge/snapshots`: the places `forge open` built. */
	snapshots: string;
}

/** The files of one session, in `.forge/sessions/<id>`. */
export interface SessionFiles {
	/** `.forge/sessions/<id>`. */
	directory: string;
	/** `supervisor.id`: the write-once {@link IdentityRecord}. */
	identity: string;
	/** `workers.lock`: the reaper's lease. */
	lease: string;
	/** `output`: the reaper appends each worker's output here. */
	output: string;
	/** `reaper.json`: the reaper's own record. */
	record: string;
	sessionId: string;
	/** `state.json`: the session's status, rewritten on each change. */
	state: string;
	/** `token`: the IPC token. */
	token: string;
}

/**
 * Who runs a session: the supervisor process, pinned by PID and OS start
 * time, so a later `down --force` never kills a process that reused the PID.
 */
export interface IdentityRecord {
	/** The IPC endpoint (`supervisor/endpoint.ts`). */
	endpoint: string;
	/** The supervisor's PID. */
	pid: number;
	/** Its OS start time, from the native addon (`processStartTime`). */
	processStartTime: string;
	sessionId: string;
	/** When the session started, as an ISO date. */
	startedAt: string;
	/** The forge version that runs it. */
	version: string;
}

/** A session's IPC token, and what writes its file. */
export interface SessionToken {
	value: string;
	/** Writes the token file; when missing, it is written with mode 0600. */
	write?: ((file: string, text: string) => void) | undefined;
}

/**
 * The `.forge` files of a project.
 *
 * @param projectRoot - The project directory.
 * @returns Their paths.
 */
export function forgeFiles(projectRoot: string): ForgeFiles {
	const directory = path.join(projectRoot, ".forge");
	return {
		current: path.join(directory, "current"),
		directory,
		lock: path.join(directory, "supervisor.lock"),
		sessions: path.join(directory, "sessions"),
		snapshots: path.join(directory, "snapshots"),
	};
}

/**
 * The files of one session.
 *
 * @param forge - The project's `.forge` files.
 * @param sessionId - The session's id: its directory name.
 * @returns The paths of its record, token, lease, reaper record, and output.
 */
export function sessionFiles(forge: ForgeFiles, sessionId: string): SessionFiles {
	const directory = path.join(forge.sessions, sessionId);
	return {
		directory,
		identity: path.join(directory, "supervisor.id"),
		lease: path.join(directory, "workers.lock"),
		output: path.join(directory, "output"),
		record: path.join(directory, "reaper.json"),
		sessionId,
		state: path.join(directory, "state.json"),
		token: path.join(directory, "token"),
	};
}

/**
 * The ids of every session directory, in no set order.
 *
 * @param fileSystem - Reads the directory.
 * @param forge - The project's `.forge` files.
 * @returns The ids; none when `.forge/sessions` does not exist.
 */
export function listSessions(
	fileSystem: Pick<FileSystem, "existsSync" | "readdirSync">,
	forge: ForgeFiles,
): Array<string> {
	return fileSystem.existsSync(forge.sessions) ? fileSystem.readdirSync(forge.sessions) : [];
}

/**
 * Create a new session's directory with its identity record and token, then
 * point `current` at it. Call only while holding the singleton lock.
 *
 * @param fileSystem - Writes the files.
 * @param forge - The project's `.forge` files.
 * @param identity - The record; its `sessionId` names the directory.
 * @param token - The IPC token, and what writes its file: by default
 *   `writeFileSync` with mode 0600. Windows passes a writer that creates it
 *   with an owner-only DACL.
 * @returns The session's files.
 * @throws When the session directory already has an identity record: a
 *   record is written once and never replaced.
 */
export function createSession(
	fileSystem: Pick<FileSystem, "mkdirSync" | "writeFileSync">,
	forge: ForgeFiles,
	identity: IdentityRecord,
	token: SessionToken,
): SessionFiles {
	const files = sessionFiles(forge, identity.sessionId);
	fileSystem.mkdirSync(files.output, { recursive: true });
	fileSystem.writeFileSync(files.identity, `${JSON.stringify(identity)}\n`, { flag: "wx" });
	if (token.write === undefined) {
		fileSystem.writeFileSync(files.token, token.value, { flag: "wx", mode: 0o600 });
	} else {
		token.write(files.token, token.value);
	}

	fileSystem.writeFileSync(forge.current, `${identity.sessionId}\n`);
	return files;
}

/**
 * Delete a session's directory, and `current` when it names that session.
 * Call only while holding the singleton lock.
 *
 * @param fileSystem - Deletes the files.
 * @param forge - The project's `.forge` files.
 * @param sessionId - The session to delete.
 */
export function removeSession(
	fileSystem: Pick<FileSystem, "existsSync" | "readFileSync" | "rmSync">,
	forge: ForgeFiles,
	sessionId: string,
): void {
	fileSystem.rmSync(sessionFiles(forge, sessionId).directory, { force: true, recursive: true });
	if (
		fileSystem.existsSync(forge.current) &&
		fileSystem.readFileSync(forge.current, "utf8").trim() === sessionId
	) {
		fileSystem.rmSync(forge.current);
	}
}
