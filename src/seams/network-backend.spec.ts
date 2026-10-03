import { encode } from "@msgpack/msgpack";

import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";

import { createFakeNetworkBackend } from "../../test/helpers/network-backend.ts";
import { createNodeNetwork } from "./network.ts";

const IDENTITY = {
	projectName: "Game@tree",
	protocolVersion: 5,
	serverVersion: "7.7.1",
	sessionId: "launch",
};

describe("local HTTP network backend", () => {
	it("should validate and decode the Rojo identity through its HTTP driver", async () => {
		expect.assertions(2);

		const fake = createFakeNetworkBackend();
		fake.fetch.mockResolvedValue(new Response(encode(IDENTITY)));

		await expect(
			createNodeNetwork(fake.backend).getRojoInfoAsync(50000),
		).resolves.toStrictEqual(IDENTITY);
		expect(fake.fetch.mock.calls[0]![0]).toBe("http://127.0.0.1:50000/api/rojo");
	});

	it("should include cancellation in the Rojo identity request", async () => {
		expect.assertions(2);

		const fake = createFakeNetworkBackend();
		fake.fetch.mockResolvedValue(new Response(encode(IDENTITY)));
		const abort = new AbortController();
		await createNodeNetwork(fake.backend).getRojoInfoAsync(50000, abort.signal);
		const { signal } = fake.fetch.mock.calls[0]![1]!;
		abort.abort();

		expect(signal!.aborted).toBeTrue();
		expect(signal!.reason).toBe(abort.signal.reason);
	});

	it("should reject a failed or incomplete Rojo API response", async () => {
		expect.assertions(2);

		const fake = createFakeNetworkBackend();
		fake.fetch
			.mockResolvedValueOnce(new Response(undefined, { status: 503 }))
			.mockResolvedValueOnce(new Response(encode({ projectName: "Foreign" })));
		const network = createNodeNetwork(fake.backend);

		await expect(network.getRojoInfoAsync(50000)).rejects.toThrow(
			"Rojo server info returned HTTP 503.",
		);
		await expect(network.getRojoInfoAsync(50000)).rejects.toThrow("sessionId must be a string");
	});

	it("should accept the exact GET once and close all active requests", async () => {
		expect.assertions(5);

		const fake = createFakeNetworkBackend();
		const listener = await createNodeNetwork(fake.backend).listenForStudioReadyAsync(IDENTITY);
		const wrong = new URL(listener.url);
		wrong.searchParams.set("sessionId", "foreign");

		expect(listener.url).toBe(
			`http://127.0.0.1:50001/ready/${"ab".repeat(32)}?projectName=Game%40tree&sessionId=launch`,
		);
		expect(fake.server.listen).toHaveBeenCalledWith(
			{ host: "127.0.0.1", port: 0 },
			expect.any(Function),
		);

		const statuses = [
			fake.request(wrong.href),
			fake.request(listener.url, "POST"),
			fake.request(listener.url),
		];

		await expect(listener.ready).resolves.toBeTrue();

		statuses.push(fake.request(listener.url));

		expect(statuses).toStrictEqual([404, 404, 204, 404]);

		listener.close();

		expect([
			fake.server.close.mock.calls,
			fake.server.closeAllConnections.mock.calls,
		]).toStrictEqual([[[]], [[]]]);
	});

	it("should cancel a published listener and remove its cancellation handler", async () => {
		expect.assertions(4);

		const fake = createFakeNetworkBackend();
		const abort = new AbortController();
		const listener = await createNodeNetwork(fake.backend).listenForStudioReadyAsync(
			IDENTITY,
			abort.signal,
		);
		abort.abort();

		await expect(listener.ready).resolves.toBeFalse();
		expect(getEventListeners(abort.signal, "abort")).toStrictEqual([]);
		expect(fake.server.close).toHaveBeenCalledOnce();
		expect(fake.server.closeAllConnections).toHaveBeenCalledOnce();
	});

	it("should reject an already cancelled launch before binding", async () => {
		expect.assertions(2);

		const fake = createFakeNetworkBackend();

		await expect(
			createNodeNetwork(fake.backend).listenForStudioReadyAsync(
				IDENTITY,
				AbortSignal.abort(),
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fake.server.listen).not.toHaveBeenCalled();
	});

	it("should close a launch cancelled during binding", async () => {
		expect.assertions(3);

		const fake = createFakeNetworkBackend();
		fake.delayBind();
		const abort = new AbortController();
		const listener = createNodeNetwork(fake.backend).listenForStudioReadyAsync(
			IDENTITY,
			abort.signal,
		);
		abort.abort();
		fake.bind();

		await expect(listener).rejects.toMatchObject({ name: "AbortError" });
		expect(fake.server.close).toHaveBeenCalledOnce();
		expect(fake.server.closeAllConnections).toHaveBeenCalledOnce();
	});

	it("should dispose a failed binding", async () => {
		expect.assertions(3);

		const fake = createFakeNetworkBackend();
		fake.delayBind();
		const listener = createNodeNetwork(fake.backend).listenForStudioReadyAsync(IDENTITY);
		fake.failBind();

		await expect(listener).rejects.toThrow("bind denied");
		expect(fake.server.close).toHaveBeenCalledOnce();
		expect(fake.server.closeAllConnections).toHaveBeenCalledOnce();
	});
});
