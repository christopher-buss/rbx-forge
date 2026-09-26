import { describe, expect, it, vi } from "vitest";

import type { Network } from "../seams/network.ts";
import { chooseRojoPortAsync, createRojoPort, DEFAULT_ROJO_PORT } from "./rojo-port.ts";

const FREE_PORT = 50_123;

/**
 * A network whose busy ports are the given ones.
 *
 * @param busy - The ports something listens on.
 * @returns The network, with its calls recorded.
 */
function networkWith(...busy: Array<number>): Pick<Network, "freePortAsync" | "isPortFreeAsync"> {
	return {
		freePortAsync: vi.fn<Network["freePortAsync"]>().mockResolvedValue(FREE_PORT),
		isPortFreeAsync: vi.fn<Network["isPortFreeAsync"]>(async (port) => !busy.includes(port)),
	};
}

describe(chooseRojoPortAsync, () => {
	it("should keep a configured port that is free", async () => {
		expect.assertions(1);

		await expect(chooseRojoPortAsync(networkWith(DEFAULT_ROJO_PORT), 4000)).resolves.toBe(4000);
	});

	it("should fail with port_in_use when the configured port is busy, and take no other", async () => {
		expect.assertions(2);

		const network = networkWith(4000);

		await expect(chooseRojoPortAsync(network, 4000)).rejects.toMatchObject({
			code: "port_in_use",
			hint: "Stop the program that uses it, set rojoPort to a free port, or remove rojoPort so forge picks one.",
			message: "Rojo port 4000 is in use.",
		});
		expect(network.freePortAsync).not.toHaveBeenCalled();
	});

	it("should take the default port when none is configured and it is free", async () => {
		expect.assertions(1);

		await expect(chooseRojoPortAsync(networkWith(), undefined)).resolves.toBe(
			DEFAULT_ROJO_PORT,
		);
	});

	it("should take a free port when none is configured and the default port is busy", async () => {
		expect.assertions(1);

		await expect(chooseRojoPortAsync(networkWith(DEFAULT_ROJO_PORT), undefined)).resolves.toBe(
			FREE_PORT,
		);
	});
});

describe(createRojoPort, () => {
	it("should have no port before the first choice", () => {
		expect.assertions(1);

		expect(createRojoPort(networkWith(), undefined).value()).toBeUndefined();
	});

	it("should keep its first choice, even once that port is busy", async () => {
		expect.assertions(3);

		const network = networkWith();
		const port = createRojoPort(network, undefined);
		const first = await port.chooseAsync();
		vi.mocked(network.isPortFreeAsync).mockResolvedValue(false);

		await expect(port.chooseAsync()).resolves.toBe(first);
		expect(port.value()).toBe(DEFAULT_ROJO_PORT);
		expect(network.isPortFreeAsync).toHaveBeenCalledOnce();
	});

	it("should choose again after a choice that failed", async () => {
		expect.assertions(2);

		const network = networkWith(4000);
		const port = createRojoPort(network, 4000);

		await expect(port.chooseAsync()).rejects.toMatchObject({ code: "port_in_use" });

		vi.mocked(network.isPortFreeAsync).mockResolvedValue(true);

		await expect(port.chooseAsync()).resolves.toBe(4000);
	});
});
