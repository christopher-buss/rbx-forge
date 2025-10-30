import { createServer } from "node:net";

import { ROJO_DEFAULT_PORT, ROJO_MAX_PORT_ATTEMPTS } from "../constants";

/**
 * Finds the next available port starting from the given port. Tries up to
 * ROJO_MAX_PORT_ATTEMPTS consecutive ports.
 *
 * @param startPort - The port to start searching from (defaults to
 *   ROJO_DEFAULT_PORT).
 * @returns Promise that resolves to an available port number.
 * @throws Error if no available port is found within the search range.
 */
export async function findAvailablePort(startPort: number = ROJO_DEFAULT_PORT): Promise<number> {
	for (let index = 0; index < ROJO_MAX_PORT_ATTEMPTS; index++) {
		const port = startPort + index;

		if (await isPortAvailable(port)) {
			return port;
		}
	}

	const endPort = startPort + ROJO_MAX_PORT_ATTEMPTS - 1;
	throw new Error(`Could not find available port for Rojo (tried ${startPort}-${endPort})`);
}

/**
 * Checks if a given port is available for binding.
 *
 * @param port - The port number to check.
 * @returns Promise that resolves to true if the port is available, false
 *   otherwise.
 */
export async function isPortAvailable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();

		server.once("error", () => {
			resolve(false);
		});

		server.once("listening", () => {
			server.close();
			resolve(true);
		});

		server.listen(port, "127.0.0.1");
	});
}
