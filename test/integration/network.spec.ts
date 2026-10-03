import { encode } from "@msgpack/msgpack";

import { getEventListeners } from "node:events";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import process from "node:process";
import { setImmediate } from "node:timers/promises";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { nodeNetwork } from "../../src/seams/network.ts";

describe("studio readiness callback", () => {
	it("should bind only its loopback address", async () => {
		expect.assertions(1);

		const listener = await nodeNetwork.listenForStudioReadyAsync({
			projectName: "Game",
			sessionId: "launch",
		});
		onTestFinished(listener.close);
		const other = new URL(listener.url);
		other.hostname = "127.0.0.2";

		await expect(fetch(other)).rejects.toThrow("fetch failed");
	});

	it("should dispose a partial HTTP request and unregister cancellation", async () => {
		expect.assertions(3);

		const abort = new AbortController();
		const listener = await nodeNetwork.listenForStudioReadyAsync(
			{ projectName: "Game", sessionId: "launch" },
			abort.signal,
		);
		const url = new URL(listener.url);
		const socket = connect({ host: url.hostname, port: Number(url.port) });
		socket.on("error", () => {});
		onTestFinished(() => {
			socket.destroy();
		});
		await new Promise<void>((resolve) => {
			socket.once("connect", resolve);
		});
		socket.write(
			"POST /partial HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000000\r\n\r\n",
		);
		await new Promise<void>((resolve) => {
			socket.once("data", () => {
				resolve();
			});
		});
		const closed = new Promise<void>((resolve) => {
			socket.once("close", () => {
				resolve();
			});
		});
		listener.close();

		await expect(closed).resolves.toBeUndefined();
		await expect(listener.ready).resolves.toBeFalse();
		expect(getEventListeners(abort.signal, "abort")).toStrictEqual([]);
	});

	it("should release an unpublished callback server cancelled during binding", async () => {
		expect.assertions(2);

		await setImmediate();
		await setImmediate();
		const before = process
			.getActiveResourcesInfo()
			.filter((resource) => resource === "TCPServerWrap");
		const abort = new AbortController();
		const listener = nodeNetwork.listenForStudioReadyAsync(
			{ projectName: "Game", sessionId: "launch" },
			abort.signal,
		);
		abort.abort();

		await expect(listener).rejects.toMatchObject({ name: "AbortError" });

		await vi.waitFor(() => {
			assert(
				process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap")
					.length === before.length,
			);
		});

		expect(
			process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap"),
		).toStrictEqual(before);
	});

	it("should bind a random launch token and identity, consume it once, and dispose", async () => {
		expect.assertions(5);

		const info = {
			projectName: "Game@tree",
			protocolVersion: 5,
			serverVersion: "7.7.1",
			sessionId: "launch",
		};
		const listener = await nodeNetwork.listenForStudioReadyAsync(info);
		onTestFinished(listener.close);
		const wrong = new URL(listener.url);
		wrong.searchParams.set("sessionId", "foreign");

		expect([...wrong.searchParams.keys()]).toStrictEqual(["projectName", "sessionId"]);
		await expect(fetch(wrong)).resolves.toMatchObject({ status: 404 });
		await expect(fetch(listener.url, { method: "POST" })).resolves.toMatchObject({
			status: 404,
		});
		await expect(fetch(listener.url)).resolves.toMatchObject({ status: 204 });
		await expect(listener.ready).resolves.toBeTrue();
	});

	it("should generate distinct random tokens and reject replayed or disposed callbacks", async () => {
		expect.assertions(5);

		const listener = await nodeNetwork.listenForStudioReadyAsync({
			projectName: "Game",
			sessionId: "launch",
		});
		onTestFinished(listener.close);
		const other = await nodeNetwork.listenForStudioReadyAsync({
			projectName: "Game",
			sessionId: "launch",
		});
		onTestFinished(other.close);
		const url = new URL(listener.url);
		const otherUrl = new URL(other.url);

		expect(url.pathname).toMatch(/^\/ready\/[a-f0-9]{64}$/u);
		expect(url.pathname).not.toBe(otherUrl.pathname);
		await expect(fetch(listener.url)).resolves.toMatchObject({ status: 204 });
		await expect(fetch(listener.url)).resolves.toMatchObject({ status: 404 });

		listener.close();

		await expect(fetch(listener.url)).rejects.toThrow("fetch failed");
	});

	it("should cancel a listening callback and release its port", async () => {
		expect.assertions(2);

		const abort = new AbortController();
		const listener = await nodeNetwork.listenForStudioReadyAsync(
			{ projectName: "Game", sessionId: "launch" },
			abort.signal,
		);
		abort.abort();

		await expect(listener.ready).resolves.toBeFalse();
		await expect(fetch(listener.url)).rejects.toThrow("fetch failed");
	});

	it("should reject cancelled and cancelled-during-bind launches", async () => {
		expect.assertions(2);

		const identity = { projectName: "Game", sessionId: "launch" };

		await expect(
			nodeNetwork.listenForStudioReadyAsync(identity, AbortSignal.abort()),
		).rejects.toMatchObject({ name: "AbortError" });

		const abort = new AbortController();
		const listener = nodeNetwork.listenForStudioReadyAsync(identity, abort.signal);
		abort.abort();

		await expect(listener).rejects.toMatchObject({ name: "AbortError" });
	});
});

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
