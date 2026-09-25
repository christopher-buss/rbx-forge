import { connect, createServer } from "node:net";

/** Local network checks. Unit tests pass a fake. */
export interface Network {
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
