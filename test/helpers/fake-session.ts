import { onTestFinished, vi } from "vitest";

import type { IpcHandler, IpcOwner, IpcServer, IpcServerOptions } from "../../src/ipc/server.ts";
import { startIpcServer } from "../../src/ipc/server.ts";
import type { SessionStatus } from "../../src/session/status.ts";
import type { IdentityRecord } from "../../src/supervisor/session-files.ts";
import { forgeFiles, sessionFiles } from "../../src/supervisor/session-files.ts";
import type { MemoryTransport } from "./fake-ipc.ts";
import type { MemoryFileSystem } from "./seams.ts";
import { PROJECT } from "./seams.ts";

/**
 * A session a client test talks to: its files in memfs, its endpoint in
 * memory.
 */
export interface FakeSession {
	/** Answers `addParts`; no part added by default. */
	addParts: IpcHandler;
	/** What `status` answers instead of the status, such as a bad answer. */
	answer?: Record<string, unknown>;
	/** Answers `freshStatus`; the status at once by default. */
	freshStatus: IpcHandler;
	identity: IdentityRecord;
	/** Answers `own`; takes and starts no part by default. */
	join: IpcHandler;
	/** Answers an owner's release; lets go of no part by default. */
	leave: IpcOwner["leave"];
	/** What `status` answers; change it to move the session on. */
	status: SessionStatus;
	/** Stop answering, as a dead supervisor does. Its files stay. */
	stop: () => Promise<void>;
	/** Answers `sync`; a synced place with no hooks by default. */
	sync: IpcHandler;
}

/** What a fake session's release answers by default: it held no part. */
export const LET_GO: Readonly<Record<string, unknown>> = {
	ending: false,
	released: [],
	sessionId: "s1",
	stopped: [],
	studioLeft: false,
};

/** What a fake session's `sync` answers by default. */
export const SYNCED: Readonly<Record<string, unknown>> = {
	durationMs: 12,
	hooks: [],
	input: `${PROJECT}/game.rbxl`,
	project: "default.project.json",
};

/**
 * A status as a supervisor reports it.
 *
 * @param overrides - Fields to change.
 * @returns A ready status of session `s1` (pid 500) that runs Rojo only.
 */
export function makeStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
	return {
		phase: "ready",
		pid: 500,
		running: true,
		services: {
			compiler: { building: false, owner: null, status: "off" },
			rojo: { owner: null, port: 34_872, status: "ready" },
			studio: { owner: null, status: "off" },
			syncback: { status: "off" },
		},
		sessionId: "s1",
		startedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

/**
 * Write a session's `.forge` files and serve its control endpoint until
 * the test ends.
 *
 * @param memory - The project's files.
 * @param transport - Where the endpoint listens.
 * @param status - What `status` answers first.
 * @returns A session whose `status` the test can change and `stop`.
 */
export async function serveFakeSessionAsync(
	memory: MemoryFileSystem,
	transport: MemoryTransport,
	status: SessionStatus = makeStatus(),
): Promise<FakeSession> {
	const identity = writeSessionFiles(memory, status);
	const session: FakeSession = {
		addParts: () => ({ added: [] }),
		freshStatus: () => answerOf(session),
		identity,
		join: () => {
			return { added: [], sessionId: status.sessionId, taken: [] };
		},
		leave: vi.fn<IpcOwner["leave"]>().mockResolvedValue({ ...LET_GO }),
		status,
		stop: async () => {
			await server.closeAsync();
		},
		sync: () => ({ ...SYNCED }),
	};
	const listener = await transport.listenAsync(identity.endpoint);
	const server: IpcServer = startIpcServer(listener, serverOptions(session));
	onTestFinished(async () => {
		await server.closeAsync();
	});
	return session;
}

function answerOf(session: FakeSession): Record<string, unknown> {
	return session.answer ?? { ...session.status };
}

/**
 * What a fake session serves: each method through the session's handler of
 * the moment, so a test can change it.
 *
 * @param session - The fake session.
 * @returns The server's handlers, owner, and token.
 */
function serverOptions(session: FakeSession): IpcServerOptions {
	return {
		handlers: {
			addParts: async (parameters) => session.addParts(parameters),
			freshStatus: async (parameters) => session.freshStatus(parameters),
			status: () => answerOf(session),
			sync: async (parameters) => session.sync(parameters),
		},
		owner: {
			join: async (parameters) => session.join(parameters),
			leave: async (how) => session.leave(how),
		},
		token: "token",
	};
}

/**
 * Write the `.forge` files that name a session: `current`, its identity
 * record, and its token (`token`).
 *
 * @param memory - The project's files.
 * @param status - The session's id, PID, and start.
 * @returns Its identity record; the endpoint is `endpoint-<id>`.
 */
function writeSessionFiles(
	{ fileSystem }: MemoryFileSystem,
	status: SessionStatus,
): IdentityRecord {
	const forge = forgeFiles(PROJECT);
	const files = sessionFiles(forge, status.sessionId);
	const identity: IdentityRecord = {
		endpoint: `endpoint-${status.sessionId}`,
		pid: status.pid,
		processStartTime: String(status.pid),
		sessionId: status.sessionId,
		startedAt: status.startedAt,
		version: "9.9.9",
	};
	fileSystem.mkdirSync(files.directory, { recursive: true });
	fileSystem.writeFileSync(files.identity, `${JSON.stringify(identity)}\n`);
	fileSystem.writeFileSync(files.token, "token");
	fileSystem.writeFileSync(forge.current, `${status.sessionId}\n`);
	return identity;
}
