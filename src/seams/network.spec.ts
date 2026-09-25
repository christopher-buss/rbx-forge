import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";

import { nodeNetwork } from "./network.ts";

/**
 * Listen on a free port of `127.0.0.1` until the test ends.
 *
 * @returns The port.
 */
async function listenAsync(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => {
		server.listen({ host: "127.0.0.1", port: 0 }, resolve);
	});
	onTestFinished(() => {
		server.close();
	});
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a TCP server's address is an object
	return (server.address() as AddressInfo).port;
}

describe(nodeNetwork.isPortFreeAsync, () => {
	it("should report a port another server listens on as busy", async () => {
		expect.assertions(1);

		const port = await listenAsync();

		await expect(nodeNetwork.isPortFreeAsync(port)).resolves.toBeFalse();
	});

	it("should report a port as free once its server is gone, and leave it free", async () => {
		expect.assertions(2);

		const server = createServer();
		const port = await new Promise<number>((resolve) => {
			server.listen({ host: "127.0.0.1", port: 0 }, () => {
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a TCP server's address is an object
				resolve((server.address() as AddressInfo).port);
			});
		});
		await new Promise((resolve) => {
			server.close(resolve);
		});

		await expect(nodeNetwork.isPortFreeAsync(port)).resolves.toBeTrue();
		// The probe closed its own server.
		await expect(nodeNetwork.isPortFreeAsync(port)).resolves.toBeTrue();
	});
});
