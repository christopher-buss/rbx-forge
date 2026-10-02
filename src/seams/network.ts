import { decode } from "@msgpack/msgpack";

import { type } from "arktype";
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect, createServer } from "node:net";

/** The identity advertised by Rojo's msgpack API. */
export interface RojoServerInfo {
	projectName: string;
	protocolVersion: number;
	serverVersion: string;
	sessionId: string;
}

/** One launch's temporary sync acknowledgement endpoint. */
export interface StudioReadyListener {
	/** Dispose the endpoint and finish an unacknowledged wait with false. */
	close: () => void;
	/** True only when the launch token and expected identity were received. */
	ready: Promise<boolean>;
	url: string;
}

const ROJO_INFO = type({
	projectName: "string",
	protocolVersion: "number",
	serverVersion: "string",
	sessionId: "string",
});

/** Local network checks. Unit tests pass a fake. */
export interface Network {
	/**
	 * A port of `127.0.0.1` the OS gave out as free a moment ago.
	 *
	 * @rejects When no server can listen at all.
	 */
	freePortAsync: () => Promise<number>;
	/**
	 * Read the local Rojo server identity; rejects invalid or failed
	 * responses.
	 */
	getRojoInfoAsync: (port: number, signal?: AbortSignal) => Promise<RojoServerInfo>;
	/**
	 * Whether a server listens on `port` of `127.0.0.1`, where Rojo serves
	 * by default: a connection to it succeeds.
	 */
	isListeningAsync: (port: number) => Promise<boolean>;
	/**
	 * Whether a server could listen on `port` of `127.0.0.1`, where Rojo
	 * serves by default. Resolves `false` when anything else listens there.
	 */
	isPortFreeAsync: (port: number) => Promise<boolean>;
	/** Bind a temporary acknowledgement endpoint before launching Studio. */
	listenForStudioReadyAsync: (
		identity: Pick<RojoServerInfo, "projectName" | "sessionId">,
		signal?: AbortSignal,
	) => Promise<StudioReadyListener>;
}

export const nodeNetwork: Network = {
	freePortAsync: async () => {
		return new Promise((resolve, reject) => {
			const server = createServer();
			// Stryker disable next-line StringLiteral,CallExpression: never fails
			server.once("error", reject);
			// Stryker disable next-line StringLiteral: equivalent
			server.listen({ host: "127.0.0.1", port: 0 }, () => {
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a TCP server's address is an object
				const { port } = server.address() as AddressInfo;
				server.close(() => {
					resolve(port);
				});
			});
		});
	},
	getRojoInfoAsync: async (port, signal) => {
		const response = await fetch(`http://127.0.0.1:${port}/api/rojo`, {
			signal: AbortSignal.any([
				AbortSignal.timeout(10_000),
				...(signal === undefined ? [] : [signal]),
			]),
		});
		if (!response.ok) {
			throw new Error(`Rojo server info returned HTTP ${response.status}.`);
		}

		return ROJO_INFO.assert(decode(new Uint8Array(await response.arrayBuffer())));
	},
	isListeningAsync: async (port) => {
		return new Promise((resolve) => {
			const socket = connect({ host: "127.0.0.1", port });
			socket.once("error", () => {
				resolve(false);
			});
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
		});
	},
	isPortFreeAsync: async (port) => {
		return new Promise((resolve) => {
			const server = createServer();
			server.once("error", () => {
				resolve(false);
			});
			server.listen({ host: "127.0.0.1", port }, () => {
				server.close(() => {
					resolve(true);
				});
			});
		});
	},
	listenForStudioReadyAsync: async ({ projectName, sessionId }, signal) => {
		signal?.throwIfAborted();
		const ready = Promise.withResolvers<boolean>();
		const query = new URLSearchParams({ projectName, sessionId });
		const route = `/ready/${randomBytes(32).toString("hex")}?${query.toString()}`;
		let isClosed = false;
		const server = createHttpServer((request, response) => {
			const isAccepted = !isClosed && request.method === "GET" && request.url === route;
			response.writeHead(isAccepted ? 204 : 404);
			response.end();
			if (isAccepted) {
				isClosed = true;
				ready.resolve(true);
			}
		});
		function close(): void {
			ready.resolve(false);
			signal?.removeEventListener("abort", close);
			server.close();
			server.closeAllConnections();
		}

		await bindReadyAsync(server, signal, close);

		signal?.addEventListener("abort", close);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- listening HTTP server has an address
		const { port } = server.address() as AddressInfo;
		return { close, ready: ready.promise, url: `http://127.0.0.1:${port}${route}` };
	},
};

/**
 * Bind the loopback server before exposing its callback URL.
 *
 * @param server - The acknowledgement server.
 * @param signal - Cancels a launch during binding.
 * @param close - Disposes a failed or cancelled binding.
 * @rejects A bind failure.
 */
async function bindReadyAsync(
	server: Server,
	signal: AbortSignal | undefined,
	close: () => void,
): Promise<void> {
	try {
		await new Promise<void>((resolve, reject) => {
			// Stryker disable next-line StringLiteral,CallExpression: OS bind
			// failure
			server.once("error", reject);
			server.listen({ host: "127.0.0.1", port: 0 }, resolve);
		});
		signal?.throwIfAborted();
	} catch (err) {
		close();
		throw err;
	}
}
