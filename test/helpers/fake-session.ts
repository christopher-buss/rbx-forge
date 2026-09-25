import { onTestFinished } from "vitest";

import type { IpcServer } from "../../src/ipc/server.ts";
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
	/** What `status` answers instead of the status, such as a bad answer. */
	answer?: Record<string, unknown>;
	identity: IdentityRecord;
	/** What `status` answers; change it to move the session on. */
	status: SessionStatus;
	/** Stop answering, as a dead supervisor does. Its files stay. */
	stop: () => Promise<void>;
}

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
			compiler: { status: "off" },
			rojo: { port: 34_872, status: "ready" },
			studio: { status: "off" },
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
		identity,
		status,
		stop: async () => {
			await server.closeAsync();
		},
	};
	const server: IpcServer = startIpcServer(await transport.listenAsync(identity.endpoint), {
		handlers: { status: () => session.answer ?? { ...session.status } },
		token: "token",
	});
	onTestFinished(async () => {
		await server.closeAsync();
	});
	return session;
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
