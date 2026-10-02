import { encode } from "@msgpack/msgpack";

import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";

import { nodeNetwork } from "./network.ts";

describe("rojo server identity", () => {
	it("should reject a failed API response", async () => {
		expect.assertions(1);

		const server = createHttpServer((_request, response) => {
			response.writeHead(503);
			response.end();
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		onTestFinished(() => {
			server.close();
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- listening HTTP server has an address
		const { port } = server.address() as AddressInfo;
		const { signal } = new AbortController();

		await expect(nodeNetwork.getRojoInfoAsync(port, signal)).rejects.toThrow(
			"Rojo server info returned HTTP 503.",
		);
	});

	it("should reject a response without a complete Rojo identity", async () => {
		expect.assertions(1);

		const server = createHttpServer((_request, response) => {
			response.end(encode({ projectName: "Foreign server" }));
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		onTestFinished(() => {
			server.close();
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- listening HTTP server has an address
		const { port } = server.address() as AddressInfo;

		await expect(nodeNetwork.getRojoInfoAsync(port)).rejects.toThrow(
			"sessionId must be a string",
		);
	});

	it("should cancel a server identity request when its session ends", async () => {
		expect.assertions(1);

		await expect(nodeNetwork.getRojoInfoAsync(1, AbortSignal.abort())).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	it("should decode the msgpack identity from the local Rojo API", async () => {
		expect.assertions(2);

		const info = {
			projectName: "Game@worktree",
			protocolVersion: 5,
			serverVersion: "7.7.1",
			sessionId: "abc123",
		};
		const server = createHttpServer((request, response) => {
			expect(request.url).toBe("/api/rojo");

			response.end(encode(info));
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		onTestFinished(() => {
			server.close();
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- listening HTTP server has an address
		const { port } = server.address() as AddressInfo;

		await expect(nodeNetwork.getRojoInfoAsync(port)).resolves.toStrictEqual(info);
	});
});

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

describe(nodeNetwork.freePortAsync, () => {
	it("should give a port that is free, and leave it free", async () => {
		expect.assertions(2);

		const port = await nodeNetwork.freePortAsync();

		expect(port).toBeGreaterThan(0);
		await expect(nodeNetwork.isPortFreeAsync(port)).resolves.toBeTrue();
	});
});

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

describe(nodeNetwork.isListeningAsync, () => {
	it("should check 127.0.0.1 only, not every name of localhost", async () => {
		expect.assertions(1);

		const server = createServer();
		const port = await new Promise<number>((resolve) => {
			server.listen({ host: "::1", port: 0 }, () => {
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a TCP server's address is an object
				resolve((server.address() as AddressInfo).port);
			});
		});
		onTestFinished(() => {
			server.close();
		});

		await expect(nodeNetwork.isListeningAsync(port)).resolves.toBeFalse();
	});

	it("should close its connection once it got through", async () => {
		expect.assertions(1);

		const closed = Promise.withResolvers<string>();
		const server = createServer((socket) => {
			socket.once("close", () => {
				closed.resolve("closed");
			});
		});
		const port = await new Promise<number>((resolve) => {
			server.listen({ host: "127.0.0.1", port: 0 }, () => {
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a TCP server's address is an object
				resolve((server.address() as AddressInfo).port);
			});
		});
		onTestFinished(() => {
			server.close();
		});
		await nodeNetwork.isListeningAsync(port);
		const timer = setTimeout(() => {
			closed.resolve("open");
		}, 2000);
		onTestFinished(() => {
			clearTimeout(timer);
		});

		await expect(closed.promise).resolves.toBe("closed");
	});

	it("should report a port a server listens on as listening", async () => {
		expect.assertions(1);

		const port = await listenAsync();

		await expect(nodeNetwork.isListeningAsync(port)).resolves.toBeTrue();
	});

	it("should report a port nothing listens on as not listening", async () => {
		expect.assertions(1);

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

		await expect(nodeNetwork.isListeningAsync(port)).resolves.toBeFalse();
	});
});
