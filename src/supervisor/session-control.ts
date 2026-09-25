import assert from "node:assert/strict";

import type { IpcListener } from "../ipc/connection.ts";
import { startIpcServer } from "../ipc/server.ts";
import type { Seams } from "../seams/seams.ts";
import type { SessionStatus, StatusStore } from "../session/status.ts";
import { createStatusStore, isReady } from "../session/status.ts";
import type { StopSource } from "../session/stop-source.ts";
import { controlHandlers } from "./control.ts";
import type { ForgeFiles, IdentityRecord, SessionFiles } from "./session-files.ts";
import { createSession, removeSession } from "./session-files.ts";

/** What a new session's files, status, and endpoint are made from. */
export interface ControlSetup {
	forge: ForgeFiles;
	identity: IdentityRecord;
	/** Called once, when the session is first ready. */
	onReady: (() => void) | undefined;
	/**
	 * The test pause point `control`: the files and `current` exist, the
	 * endpoint does not.
	 */
	pause: () => Promise<void>;
	/** What the session runs, for its first status. */
	plan: { compiler: boolean; open: boolean; syncback: boolean };
	/** The fixed Rojo port. */
	port: number;
	/** The supervisor's stop requests: `shutdown` feeds them. */
	stop: StopSource;
}

/** A session's files, status, and open control endpoint. */
export interface SessionControl {
	/**
	 * Stop serving, once every request in progress has an answer. Call last,
	 * so the final status is what late clients see.
	 */
	closeAsync: () => Promise<void>;
	files: SessionFiles;
	status: StatusStore;
}

/** The seams a session's control opens with. */
export type ControlSeams = Pick<
	Seams,
	"clock" | "fileSystem" | "host" | "ipc" | "native" | "randomId"
>;

/**
 * Step 5 of the supervisor (spec #28, "Startup order"): create the session
 * directory with its identity record and token, keep `state.json` up to
 * date, and open the control endpoint (`status`, `shutdown`). Call only
 * while holding the singleton lock. When the endpoint cannot open, nothing
 * of the session ran, so its files go.
 *
 * @param seams - The clock, file system, host, transport, addon, and ids.
 * @param setup - The identity, plan, port, stop requests, and `onReady`.
 * @returns The session's files, its status, and the endpoint's close.
 * @rejects `endpoint_in_use`.
 */
export async function openSessionAsync(
	seams: ControlSeams,
	setup: ControlSetup,
): Promise<SessionControl> {
	const token = seams.randomId();
	const files = createSession(seams.fileSystem, setup.forge, setup.identity, {
		value: token,
		write: tokenWriter(seams),
	});
	const status = createSessionStatus(seams, setup, files.state);
	await setup.pause();
	const listener = await listenOrRemoveAsync(seams, setup, files.sessionId);
	const server = startIpcServer(listener, {
		handlers: controlHandlers({
			sessionId: setup.identity.sessionId,
			status,
			stop: setup.stop,
		}),
		token,
	});
	// The stop source lives as long as this supervisor: no removal needed.
	setup.stop.onStop(() => {
		status.phase("stopping");
	});
	return {
		closeAsync: async () => {
			await server.closeAsync();
		},
		files,
		status,
	};
}

/**
 * Open the endpoint; when it cannot open, delete the session's files.
 *
 * @param seams - The transport and file system.
 * @param setup - The endpoint, in the identity record.
 * @param sessionId - The session whose files go on failure.
 * @returns The listening endpoint.
 * @rejects `endpoint_in_use`.
 */
async function listenOrRemoveAsync(
	seams: Pick<ControlSeams, "fileSystem" | "ipc">,
	{ forge, identity }: Pick<ControlSetup, "forge" | "identity">,
	sessionId: string,
): Promise<IpcListener> {
	try {
		return await seams.ipc.listenAsync(identity.endpoint);
	} catch (err) {
		removeSession(seams.fileSystem, forge, sessionId);
		throw err;
	}
}

/**
 * How the token file is written: on Windows with an owner-only DACL through
 * the addon, so it never exists readable by others; elsewhere with mode
 * 0600 (the default).
 *
 * @param seams - The host and native addon.
 * @returns The Windows writer, or `undefined` for the default.
 */
function tokenWriter(
	seams: Pick<ControlSeams, "host" | "native">,
): ((file: string, text: string) => void) | undefined {
	if (seams.host.platform !== "win32") {
		return undefined;
	}

	return (file, text) => {
		const { writePrivateFile } = seams.native();
		assert(writePrivateFile !== undefined);
		writePrivateFile(file, text);
	};
}

/**
 * Pass on each status, and call `onReady` the first time one is ready.
 *
 * @param onReady - Called once.
 * @param onChange - Gets every status.
 * @returns The listener to give the status store.
 */
function watchReady(
	onReady: (() => void) | undefined,
	onChange: (status: SessionStatus) => void,
): (status: SessionStatus) => void {
	let isAnnounced = false;
	return (status) => {
		onChange(status);
		if (!isAnnounced && isReady(status)) {
			isAnnounced = true;
			onReady?.();
		}
	};
}

/**
 * Write `state.json` whole: a temporary file, then a rename, so a reader
 * never sees half of it. It is informational: a failed write (the directory
 * is gone once the session ended) changes nothing.
 *
 * @param fileSystem - Writes the file.
 * @param file - `state.json`.
 * @param status - The status now.
 */
function writeState(
	fileSystem: ControlSeams["fileSystem"],
	file: string,
	status: SessionStatus,
): void {
	const temporary = `${file}.tmp`;
	try {
		fileSystem.writeFileSync(temporary, `${JSON.stringify(status)}\n`);
		fileSystem.renameSync(temporary, file);
	} catch {
		// Informational only; the IPC status is the live one.
	}
}

function firstStatus({
	identity,
	plan,
	port,
}: ControlSetup): Parameters<typeof createStatusStore>[0] {
	return {
		...plan,
		pid: identity.pid,
		port,
		sessionId: identity.sessionId,
		startedAt: identity.startedAt,
	};
}

/**
 * The session's status store: it starts from the plan and writes each
 * change to `state.json`.
 *
 * @param seams - The clock and file system.
 * @param setup - The identity, plan, port, and `onReady`.
 * @param stateFile - `state.json`.
 * @returns A store whose first status is `starting`.
 */
function createSessionStatus(
	seams: Pick<ControlSeams, "clock" | "fileSystem">,
	setup: ControlSetup,
	stateFile: string,
): StatusStore {
	return createStatusStore(
		firstStatus(setup),
		seams.clock.now,
		watchReady(setup.onReady, (next) => {
			writeState(seams.fileSystem, stateFile, next);
		}),
	);
}
