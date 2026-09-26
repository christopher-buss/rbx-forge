import { ForgeError } from "../errors.ts";
import type { Network } from "../seams/network.ts";

/** The port Rojo and its Studio plugin use by default. */
export const DEFAULT_ROJO_PORT = 34_872;

/** The Rojo port of one session: chosen once, then kept. */
export interface RojoPort {
	/**
	 * The session's port: the one chosen before, else a new choice.
	 *
	 * @rejects {ForgeError} `port_in_use` when the configured port is busy.
	 */
	chooseAsync: () => Promise<number>;
	/** The port chosen so far, if any. */
	value: () => number | undefined;
}

/**
 * Choose the port Rojo serves on: a configured port is fixed and must be
 * free; with none, {@link DEFAULT_ROJO_PORT} when it is free, else a free
 * port.
 *
 * @param network - Checks and finds ports.
 * @param configured - `rojoPort` from the config or a flag, if set.
 * @returns The configured port, 34872, or a port the OS gave out.
 * @rejects {ForgeError} `port_in_use` when the configured port is busy.
 */
export async function chooseRojoPortAsync(
	network: Pick<Network, "freePortAsync" | "isPortFreeAsync">,
	configured: number | undefined,
): Promise<number> {
	if (configured !== undefined) {
		if (!(await network.isPortFreeAsync(configured))) {
			throw new ForgeError("port_in_use", `Rojo port ${configured} is in use.`, {
				hint: "Stop the program that uses it, set rojoPort to a free port, or remove rojoPort so forge picks one.",
			});
		}

		return configured;
	}

	return (await network.isPortFreeAsync(DEFAULT_ROJO_PORT))
		? DEFAULT_ROJO_PORT
		: network.freePortAsync();
}

/**
 * Keep a session's Rojo port: the first choice stays for the session's
 * life, so a Rojo that starts again serves where its Studio connects.
 *
 * @param network - Checks and finds ports.
 * @param configured - `rojoPort` from the config or a flag, if set.
 * @returns The session's port, with none chosen yet.
 */
export function createRojoPort(
	network: Pick<Network, "freePortAsync" | "isPortFreeAsync">,
	configured: number | undefined,
): RojoPort {
	let port: number | undefined;
	return {
		chooseAsync: async () => {
			port ??= await chooseRojoPortAsync(network, configured);
			return port;
		},
		value: () => port,
	};
}
