import assert from "node:assert/strict";
import type nodeFs from "node:fs";
import type { Server, Socket } from "node:net";
import path from "node:path";

import { ForgeError } from "../errors.ts";
import type { NativeLoader } from "../native/addon.ts";
import type { IpcConnection, IpcListener } from "./connection.ts";
import { nativeListener, socketListener, streamConnection } from "./connection.ts";

/**
 * Opens and reaches a session's endpoint. Unit tests pass an in-memory
 * transport (`test/helpers/fake-ipc.ts`).
 */
export interface IpcTransport {
	/**
	 * Connect to an endpoint, waiting at most `timeoutMs`.
	 *
	 * @returns The connection, or `undefined` when nothing this user can
	 *   reach listens there.
	 */
	connectAsync: (endpoint: string, timeoutMs: number) => Promise<IpcConnection | undefined>;
	/**
	 * Open an endpoint. Call only while holding the singleton lock: on POSIX
	 * it removes a stale socket first.
	 *
	 * @rejects {ForgeError} `endpoint_in_use` when it cannot be opened.
	 */
	listenAsync: (endpoint: string) => Promise<IpcListener>;
}

/** What the real transport is built from. */
export interface NodeTransportBackend {
	fileSystem: Pick<typeof nodeFs, "chmodSync" | "lstatSync" | "mkdirSync" | "rmSync">;
	native: NativeLoader;
	net: { connect: (endpoint: string) => Socket; createServer: () => Server };
	platform: NodeJS.Platform;
	/** POSIX: the user who must own the socket's directory. */
	userId: number | undefined;
}

/** Owner-only: the socket's directory (spec #28). */
const DIRECTORY_MODE = 0o700;
/** Owner read and write: the socket. */
const SOCKET_MODE = 0o600;
const PERMISSION_BITS = 0o777;

/**
 * The real transport: on Windows a native named pipe server (owner-only
 * DACL, remote clients rejected, first instance), elsewhere a Unix socket in
 * an owner-only directory. Clients connect through `node:net` on both.
 *
 * @param backend - The OS facts, file system, native addon, and `node:net`.
 * @returns A transport for this OS.
 */
export function createNodeTransport(backend: NodeTransportBackend): IpcTransport {
	return {
		connectAsync: async (endpoint, timeoutMs) => {
			const socket = backend.net.connect(endpoint);
			const isConnected = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => {
					resolve(false);
				}, timeoutMs);
				socket.once("connect", () => {
					clearTimeout(timer);
					resolve(true);
				});
				socket.once("error", () => {
					clearTimeout(timer);
					resolve(false);
				});
			});
			if (!isConnected) {
				socket.destroy();
				return;
			}

			return streamConnection(socket);
		},
		listenAsync: async (endpoint) => {
			return backend.platform === "win32"
				? listenPipe(backend, endpoint)
				: listenSocketAsync(backend, endpoint);
		},
	};
}

function inUse(endpoint: string, reason: string, cause?: unknown): ForgeError {
	return new ForgeError(
		"endpoint_in_use",
		`Cannot open the control endpoint ${endpoint}: ${reason}`,
		{
			cause,
			hint: "Another program uses it. Stop that program, then start again.",
		},
	);
}

function hasCode(err: unknown, code: string): boolean {
	return err instanceof Error && "code" in err && err.code === code;
}

/**
 * Make the socket's directory owner-only: create it 0700, or check that an
 * existing one is a real directory of this user and reset its mode.
 *
 * @param backend - The file system and user id.
 * @param endpoint - The socket path.
 * @throws {ForgeError} `endpoint_in_use` when the directory is not this
 *   user's own directory.
 */
function prepareSocketDirectory(
	{ fileSystem, userId }: NodeTransportBackend,
	endpoint: string,
): void {
	const directory = path.dirname(endpoint);
	try {
		fileSystem.mkdirSync(directory, { mode: DIRECTORY_MODE });
	} catch (err) {
		if (!hasCode(err, "EEXIST")) {
			throw inUse(endpoint, "its directory cannot be created.", err);
		}
	}

	const stat = fileSystem.lstatSync(directory);
	if (!stat.isDirectory() || stat.uid !== userId) {
		throw inUse(endpoint, `${directory} is not a directory of this user.`);
	}

	if ((stat.mode & PERMISSION_BITS) !== DIRECTORY_MODE) {
		fileSystem.chmodSync(directory, DIRECTORY_MODE);
	}
}

async function listenSocketAsync(
	backend: NodeTransportBackend,
	endpoint: string,
): Promise<IpcListener> {
	prepareSocketDirectory(backend, endpoint);
	// Only the singleton holder gets here: a socket left here is stale.
	backend.fileSystem.rmSync(endpoint, { force: true });
	const server = backend.net.createServer();
	const listener = socketListener(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", (err) => {
			reject(inUse(endpoint, err.message, err));
		});
		server.listen(endpoint, resolve);
	});
	backend.fileSystem.chmodSync(endpoint, SOCKET_MODE);
	return listener;
}

function listenPipe(backend: NodeTransportBackend, endpoint: string): IpcListener {
	const { createPipeServer } = backend.native();
	assert(createPipeServer !== undefined);
	try {
		return nativeListener(createPipeServer(endpoint, true));
	} catch (err) {
		throw inUse(endpoint, "another process holds the pipe.", err);
	}
}
