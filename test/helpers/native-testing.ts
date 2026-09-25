import { randomUUID } from "node:crypto";
import nodeFs from "node:fs";
import nodeNet from "node:net";
import path from "node:path";
import process from "node:process";
import { onTestFinished } from "vitest";

import type { IpcServer } from "../../src/ipc/server.ts";
import { startIpcServer } from "../../src/ipc/server.ts";
import type { IpcTransport } from "../../src/ipc/transport.ts";
import { createNodeTransport } from "../../src/ipc/transport.ts";
import type { NativeAddon, NativeSecurity } from "../../src/native/addon.ts";
import { endpointFor } from "../../src/supervisor/endpoint.ts";
import { loadRealNative } from "./real-native.ts";
import { makeTemporaryDirectory } from "./temporary-directory.ts";

/** The addon with the exports only tests call (Windows). */
export interface NativeTestAddon extends NativeAddon {
	connectPipeAs?: (path: string, user: string, password: string, write: boolean) => number;
	currentUserSid?: () => string;
	fileSecurity?: (path: string) => NativeSecurity;
	joinNewJob?: (breakawayOk: boolean) => void;
}

/** A control endpoint served for one test. */
export interface ServedEndpoint {
	endpoint: string;
	server: IpcServer;
	token: string;
}

/**
 * The real addon, with its test-only exports.
 *
 * @returns The addon from `reaper/target/napi`.
 */
export function loadTestNative(): NativeTestAddon {
	return loadRealNative();
}

/**
 * The real transport, over the real addon, `node:net`, and the disk.
 *
 * @returns The transport forge uses on this OS.
 */
export function realTransport(): IpcTransport {
	const native = loadTestNative();
	return createNodeTransport({
		fileSystem: nodeFs,
		native: () => native,
		net: nodeNet,
		platform: process.platform,
		userId: process.getuid?.(),
	});
}

/**
 * Open a real endpoint that answers `status` with `{ ok: 1 }`, until the
 * test ends.
 *
 * @param transport - The transport that opens it.
 * @returns The endpoint, its server, and its token.
 */
export async function serveEndpointAsync(transport: IpcTransport): Promise<ServedEndpoint> {
	const endpoint = freshEndpoint();
	const token = randomUUID();
	const server = startIpcServer(await transport.listenAsync(endpoint), {
		handlers: { status: () => ({ ok: 1 }) },
		token,
	});
	onTestFinished(async () => {
		await server.closeAsync();
	});
	return { endpoint, server, token };
}

/**
 * Whether `path` exists, for the socket file.
 *
 * @param file - The path.
 * @returns `true` when something is there.
 */
export function exists(file: string): boolean {
	return nodeFs.existsSync(file);
}

/**
 * A fresh endpoint name for one test: a unique pipe on Windows, a socket
 * under a temporary runtime directory elsewhere.
 *
 * @returns A pipe path or socket path nothing else uses.
 */
function freshEndpoint(): string {
	return endpointFor({
		buildOutputPath: randomUUID(),
		env: { XDG_RUNTIME_DIR: makeTemporaryDirectory() },
		platform: process.platform,
		projectRoot: path.resolve("/forge-test"),
		userId: process.getuid?.(),
	});
}
