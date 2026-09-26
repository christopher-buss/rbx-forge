import type { AddressInfo } from "node:net";
import { connect, createServer } from "node:net";

/** Local network checks. Unit tests pass a fake. */
export interface Network {
	/**
	 * A port of `127.0.0.1` the OS gave out as free a moment ago.
	 *
	 * @rejects When no server can listen at all.
	 */
	freePortAsync: () => Promise<number>;
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
			server.once("error", reject);
			server.listen({ host: "127.0.0.1", port: 0 }, () => {
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a TCP server's address is an object
				const { port } = server.address() as AddressInfo;
				server.close(() => {
					resolve(port);
				});
			});
		});
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
