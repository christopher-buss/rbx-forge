import { decode } from "@msgpack/msgpack";

import { type } from "arktype";
import type { AddressInfo } from "node:net";
import { connect, createServer } from "node:net";

/** The identity advertised by Rojo's msgpack API. */
export interface RojoServerInfo {
	projectName: string;
	protocolVersion: number;
	serverVersion: string;
	sessionId: string;
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
};
