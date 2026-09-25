import { type } from "arktype";

import { ForgeError } from "../errors.ts";
import { callSessionAsync } from "../ipc/client.ts";
import { IPC_WAIT_MS } from "../ipc/protocol.ts";
import type { IpcTransport } from "../ipc/transport.ts";
import type { FileSystem } from "../seams/file-system.ts";
import type { SessionStatus } from "../session/status.ts";
import { parseStatus } from "../session/status.ts";
import type { ForgeFiles, IdentityRecord, SessionFiles } from "../supervisor/session-files.ts";
import { sessionFiles } from "../supervisor/session-files.ts";

/** A session the `.forge` files name, with what reaches it. */
export interface KnownSession {
	files: SessionFiles;
	identity: IdentityRecord;
	/** The token its control channel wants. */
	token: string;
}

const identityLine = type("string.json.parse").pipe(
	type({
		endpoint: "string",
		pid: "number.integer",
		processStartTime: "string",
		sessionId: "string",
		startedAt: "string",
		version: "string",
	}),
);

/**
 * Read an identity record.
 *
 * @param fileSystem - Reads the file.
 * @param file - `supervisor.id`.
 * @returns The record, or `undefined` when it is missing or not a record.
 */
export function readIdentity(
	fileSystem: Pick<FileSystem, "readFileSync">,
	file: string,
): IdentityRecord | undefined {
	// A missing file reads as no text, which is no record either.
	const parsed = identityLine(readText(fileSystem, file));
	return parsed instanceof type.errors ? undefined : parsed;
}

/**
 * The session `.forge/current` names, with its identity record and token.
 * The files are a hint: the session may have ended since.
 *
 * @param fileSystem - Reads the files.
 * @param forge - The project's `.forge` files.
 * @returns The session, or `undefined` when no complete session is named.
 */
export function findSession(
	fileSystem: Pick<FileSystem, "readFileSync">,
	forge: ForgeFiles,
): KnownSession | undefined {
	const sessionId = readText(fileSystem, forge.current)?.trim();
	if (sessionId === undefined) {
		return undefined;
	}

	const files = sessionFiles(forge, sessionId);
	const identity = readIdentity(fileSystem, files.identity);
	const token = readText(fileSystem, files.token);
	if (identity === undefined || token === undefined) {
		return undefined;
	}

	return { files, identity, token };
}

/**
 * Ask a session for its status.
 *
 * @param ipc - Reaches its endpoint.
 * @param session - Its identity record and token.
 * @param waitMs - Ask for the status once the last build is fresh
 *   (`freshStatus`), waiting up to this long; omit for the status now.
 * @returns The status it answered, checked against the state contract.
 * @rejects {ForgeError} `not_running` when nothing answers at its endpoint;
 *   `supervisor_unresponsive` when it does not answer in time;
 *   `internal_error` when the answer is not a status; the wait's own
 *   failure, such as `compile_timeout` or `service_failed`.
 */
export async function fetchStatusAsync(
	ipc: IpcTransport,
	session: KnownSession,
	waitMs?: number,
): Promise<SessionStatus> {
	const result = await callSessionAsync(
		ipc,
		{ endpoint: session.identity.endpoint, token: session.token },
		waitMs === undefined ? "status" : "freshStatus",
		waitMs === undefined
			? {}
			: { params: { timeoutMs: waitMs }, responseTimeoutMs: waitMs + IPC_WAIT_MS },
	);
	const status = parseStatus(result);
	if (status === undefined) {
		throw new ForgeError("internal_error", "The session answered status with something else.", {
			hint: "The session may run another forge version. Stop it, then start it again.",
		});
	}

	return status;
}

/**
 * The status of the project's running session, if one answers.
 *
 * @param seams - The file system and transport.
 * @param forge - The project's `.forge` files.
 * @returns The session and its status, or `undefined` when none answers.
 * @rejects {ForgeError} `internal_error` when it answers with something
 *   other than a status.
 */
export async function probeSessionAsync(
	seams: { fileSystem: Pick<FileSystem, "readFileSync">; ipc: IpcTransport },
	forge: ForgeFiles,
): Promise<undefined | { session: KnownSession; status: SessionStatus }> {
	const session = findSession(seams.fileSystem, forge);
	if (session === undefined) {
		return undefined;
	}

	try {
		return { session, status: await fetchStatusAsync(seams.ipc, session) };
	} catch (err) {
		if (err instanceof ForgeError && err.code !== "internal_error") {
			return undefined;
		}

		throw err;
	}
}

function readText(fileSystem: Pick<FileSystem, "readFileSync">, file: string): string | undefined {
	try {
		return fileSystem.readFileSync(file, "utf8");
	} catch {
		// Missing, or deleted meanwhile: the session is gone or not made yet.
		return undefined;
	}
}
