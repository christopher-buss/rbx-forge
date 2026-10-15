import { fromAny } from "@total-typescript/shoehorn";

import { Buffer } from "node:buffer";
import { EventEmitter, getEventListeners } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { assert, describe, it, vi } from "vitest";
import type { TestContext } from "vitest";

import { createFakeNetworkBackend } from "../../test/helpers/network-backend.ts";
import type { NetworkBackend } from "../seams/network.ts";
import { createNodeNetwork } from "../seams/network.ts";
import type { CaptureAddress } from "./protocol.ts";

const IDENTITY = { projectName: "Game@tree", sessionId: "current" };
type Handler = (incoming: IncomingMessage, response: ServerResponse) => void;
type Chunks = AsyncIterable<Buffer | string> | Iterable<Buffer | string>;

interface Reply {
	body: string;
	status: number;
}

interface ResponseDriver extends EventEmitter {
	end: (body?: string) => ResponseDriver;
	statusCode: number;
	writeHead: (status: number) => ResponseDriver;
}

/**
 * Drive HTTP requests at the Network seam without a socket.
 * @returns The fake network and its HTTP request driver.
 */
function createCaptureBackend() {
	const fake = createFakeNetworkBackend();
	function unbound(): never {
		assert.fail("The listener has not bound");
	}

	let handler: Handler = unbound;
	const backend: NetworkBackend = {
		...fake.backend,
		createHttpServer: fromAny((listener: Handler) => {
			handler = listener;
			return fake.server;
		}),
	};
	return {
		...fake,
		backend,
		request: (
			url: string | undefined,
			method = "GET",
			chunks: Chunks = [],
			headers: Record<string, string> = {},
		) => {
			const finished = Promise.withResolvers<Reply>();
			const response: ResponseDriver = Object.assign(new EventEmitter(), {
				end: (body = "") => {
					finished.resolve({ body, status: response.statusCode });
					response.emit("close");
					return response;
				},
				statusCode: 0,
				writeHead: (status: number) => {
					response.statusCode = status;
					return response;
				},
			});
			const incoming = Object.assign(Readable.from(chunks), { headers, method, url });
			handler(fromAny(incoming), fromAny(response));
			return { close: () => response.emit("close"), finished: finished.promise };
		},
	};
}

/**
 * Keep listener cleanup beside its test's lifetime.
 * @param root0 - The test's cleanup registration.
 * @param options - The listener's address and session cancellation.
 * @returns A bound listener with its fake HTTP drivers.
 */
async function fixtureAsync(
	{ onTestFinished }: Pick<TestContext, "onTestFinished">,
	options: { address?: CaptureAddress; signal?: AbortSignal } = {},
) {
	const fake = createCaptureBackend();
	const listener = await createNodeNetwork(fake.backend).listenForCaptureAsync(
		IDENTITY,
		options.signal,
		options.address,
	);
	onTestFinished(listener.close);
	return { ...fake, listener };
}

/**
 * Frame independent metadata and model bytes as the plugin does.
 * @param metadata - Capture metadata encoded as JSON.
 * @param model - Raw serialized instance bytes.
 * @returns The length-prefixed metadata followed by the model bytes.
 */
function frame(metadata: string, model = Buffer.from([0, 128, 255])): Buffer {
	const json = Buffer.from(metadata);
	const header = Buffer.alloc(4);
	header.writeUInt32LE(json.length);
	return Buffer.concat([header, json, model]);
}

/**
 * Read the request identifier that Studio receives from a long poll.
 * @param fixture - The listener and its fake HTTP request driver.
 * @returns The capture response URL for the pending request.
 */
async function dispatchedUrlAsync(
	fixture: Awaited<ReturnType<typeof fixtureAsync>>,
): Promise<string> {
	const reply = await fixture.request(fixture.listener.url).finished;
	const body: unknown = JSON.parse(reply.body);
	assert(typeof body === "object" && body !== null && "requestId" in body);
	assert(typeof body.requestId === "string");
	return `${fixture.listener.url}&requestId=${body.requestId}`;
}

describe("capture listener", () => {
	it("should publish only the capture interface and project a full Rojo identity", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(2);

		const fake = createCaptureBackend();
		const identity = { ...IDENTITY, protocolVersion: 5, serverVersion: "7.7.1" };
		const listener = await createNodeNetwork(fake.backend).listenForCaptureAsync(identity);
		onTestFinished(listener.close);
		const url = new URL(listener.url);

		expect([...url.searchParams.entries()]).toStrictEqual([
			["projectName", "Game@tree"],
			["sessionId", "current"],
		]);
		expect(Object.keys(listener).sort()).toStrictEqual(["captureAsync", "close", "url"]);
	});

	it("should round-trip binary roots and the current identity", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(5);

		const fixture = await fixtureAsync({ onTestFinished });
		const poll = fixture.request(fixture.listener.url);
		const capturing = fixture.listener.captureAsync(AbortSignal.any([]));
		const reply = await poll.finished;

		expect(JSON.parse(reply.body)).toStrictEqual({
			...IDENTITY,
			requestId: "ab".repeat(16),
		});
		await expect(
			fixture.request(fixture.listener.url, "DELETE").finished,
		).resolves.toMatchObject({ status: 404 });

		const response = await fixture.request(
			`${fixture.listener.url}&requestId=${"ab".repeat(16)}`,
			"POST",
			[
				frame(
					'{"services":[{"name":"Workspace","roots":[0]},{"name":"ReplicatedStorage","roots":[1]}]}',
				),
			],
		).finished;

		expect(response.status).toBe(204);
		await expect(capturing).resolves.toStrictEqual({
			model: new Uint8Array([0, 128, 255]),
			services: [
				{ name: "Workspace", roots: [0] },
				{ name: "ReplicatedStorage", roots: [1] },
			],
		});
		await expect(
			fixture.request(`${fixture.listener.url}&requestId=${"ab".repeat(16)}`, "POST")
				.finished,
		).resolves.toMatchObject({ status: 404 });
	});

	it("should accept chunked text from an HTTP body driver", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(1);

		const fixture = await fixtureAsync(
			{ onTestFinished },
			{ address: { port: 50001, secret: "saved" } },
		);
		const capturing = fixture.listener.captureAsync(AbortSignal.any([]));
		const url = await dispatchedUrlAsync(fixture);
		const bytes = frame('{"services":[]}', Buffer.from("model"));
		await fixture.request(url, "POST", [bytes.subarray(0, 4), bytes.subarray(4).toString()])
			.finished;

		await expect(capturing).resolves.toStrictEqual({
			model: new Uint8Array([109, 111, 100, 101, 108]),
			services: [],
		});
	});

	it("should reject invalid metadata with a stable capture error", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(2);

		const fixture = await fixtureAsync({ onTestFinished });
		const rejected = expect(
			fixture.listener.captureAsync(AbortSignal.any([])),
		).rejects.toMatchObject({ code: "capture_rejected" });
		const url = await dispatchedUrlAsync(fixture);
		const reply = await fixture.request(url, "POST", [frame("{")]).finished;

		await rejected;

		expect(reply.status).toBe(400);
	});

	it.for([
		{ name: "missing frame", body: Buffer.from([0]) },
		{ name: "truncated metadata", body: Buffer.from([10, 0, 0, 0, 123]) },
		{ name: "wrong service shape", body: frame('{"services":[{"name":"","roots":[-1]}]}') },
	])(
		"should reject $name without accepting a capture",
		async ({ body }, { expect, onTestFinished }) => {
			expect.assertions(2);

			const fixture = await fixtureAsync({ onTestFinished });
			const rejected = expect(
				fixture.listener.captureAsync(AbortSignal.any([])),
			).rejects.toMatchObject({ code: "capture_rejected" });
			const url = await dispatchedUrlAsync(fixture);
			const reply = await fixture.request(url, "POST", [body]).finished;

			await rejected;

			expect(reply.status).toBe(400);
		},
	);

	it("should report Studio's rejection as a capture error", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(2);

		const fixture = await fixtureAsync({ onTestFinished });
		const rejected = expect(
			fixture.listener.captureAsync(AbortSignal.any([])),
		).rejects.toMatchObject({
			code: "capture_rejected",
			details: { response: '{"error":"play_mode"}' },
		});
		const url = await dispatchedUrlAsync(fixture);
		const reply = await fixture.request(url, "POST", ['{"error":"play_mode"}'], {
			"content-type": "application/json",
		}).finished;

		await rejected;

		expect(reply.status).toBe(400);
	});

	it("should stop reading an oversized capture", async ({ expect, onTestFinished }) => {
		expect.assertions(2);

		const fixture = await fixtureAsync({ onTestFinished });
		const rejected = expect(
			fixture.listener.captureAsync(AbortSignal.any([])),
		).rejects.toMatchObject({
			code: "capture_rejected",
			message: "The capture exceeds the size limit.",
		});
		const url = await dispatchedUrlAsync(fixture);
		const chunk = Buffer.alloc(1024 * 1024);
		const reply = await fixture.request(
			url,
			"POST",
			Array.from<Buffer>({ length: 129 }).fill(chunk),
		).finished;

		await rejected;

		expect(reply.status).toBe(400);
	});

	it.for([
		{
			name: "wrong secret",
			method: "GET",
			url: "/capture/wrong?projectName=Game%40tree&sessionId=current",
		},
		{
			name: "wrong project",
			method: "GET",
			url: `/capture/${"ab".repeat(32)}?projectName=other&sessionId=current`,
		},
		{
			name: "wrong session",
			method: "GET",
			url: `/capture/${"ab".repeat(32)}?projectName=Game%40tree&sessionId=other`,
		},
		{ name: "missing URL", method: "GET", url: undefined },
		{ name: "invalid URL", method: "GET", url: "http://[" },
		{
			name: "wrong method",
			method: "DELETE",
			url: `/capture/${"ab".repeat(32)}?projectName=Game%40tree&sessionId=current`,
		},
		{
			name: "unsolicited post",
			method: "POST",
			url: `/capture/${"ab".repeat(32)}?projectName=Game%40tree&sessionId=current`,
		},
	])("should reject $name", async ({ method, url }, { expect, onTestFinished }) => {
		expect.assertions(1);

		const fixture = await fixtureAsync({ onTestFinished });

		await expect(fixture.request(url, method).finished).resolves.toMatchObject({ status: 404 });
	});

	it("should require a dispatched request identifier", async ({ expect, onTestFinished }) => {
		expect.assertions(3);

		const fixture = await fixtureAsync({ onTestFinished });
		const abort = new AbortController();
		const rejected = expect(fixture.listener.captureAsync(abort.signal)).rejects.toMatchObject({
			code: "capture_timeout",
		});

		await expect(
			fixture.request(`${fixture.listener.url}&requestId=${"ab".repeat(16)}`, "POST")
				.finished,
		).resolves.toMatchObject({ status: 404 });

		await dispatchedUrlAsync(fixture);

		const stale = await fixture.request(`${fixture.listener.url}&requestId=stale`, "POST")
			.finished;

		abort.abort();
		await rejected;

		expect(stale.status).toBe(404);
	});

	it("should distinguish an absent plugin from an unresponsive one", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(2);

		const fixture = await fixtureAsync({ onTestFinished });
		const absent = new AbortController();
		const absentResult = expect(
			fixture.listener.captureAsync(absent.signal),
		).rejects.toMatchObject({
			code: "capture_not_connected",
			message: "The forge plugin is not connected; connect Studio to the session's Rojo.",
		});
		absent.abort();
		await absentResult;
		const busy = new AbortController();
		const busyResult = fixture.listener.captureAsync(busy.signal);
		await dispatchedUrlAsync(fixture);
		busy.abort();

		await expect(busyResult).rejects.toMatchObject({ code: "capture_timeout" });
	});

	it("should reject overlapping captures and release cancellation listeners", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(3);

		const fixture = await fixtureAsync({ onTestFinished });
		const abort = new AbortController();
		const first = expect(fixture.listener.captureAsync(abort.signal)).rejects.toMatchObject({
			code: "capture_not_connected",
		});

		await expect(fixture.listener.captureAsync(AbortSignal.any([]))).rejects.toMatchObject({
			code: "capture_rejected",
		});

		abort.abort();
		await first;

		expect(getEventListeners(abort.signal, "abort")).toStrictEqual([]);
	});

	it("should finish long polls and close a session's pending capture on cancellation", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(4);

		const session = new AbortController();
		const fixture = await fixtureAsync({ onTestFinished }, { signal: session.signal });
		const captureAbort = new AbortController();
		const rejected = expect(
			fixture.listener.captureAsync(captureAbort.signal),
		).rejects.toMatchObject({ code: "capture_timeout" });
		await dispatchedUrlAsync(fixture);
		const poll = fixture.request(fixture.listener.url);
		session.abort();
		captureAbort.abort();
		await rejected;

		await expect(poll.finished).resolves.toMatchObject({ status: 204 });
		expect(getEventListeners(session.signal, "abort")).toStrictEqual([]);

		await expect(fixture.request(fixture.listener.url).finished).resolves.toMatchObject({
			status: 404,
		});
	});

	it("should reject captures on a closed or already cancelled listener", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(3);

		const fixture = await fixtureAsync({ onTestFinished });

		await expect(fixture.listener.captureAsync(AbortSignal.abort())).rejects.toMatchObject({
			name: "AbortError",
		});

		fixture.listener.close();
		const { url } = fixture.listener;
		fixture.server.address = fromAny(() => null);

		expect(fixture.listener.url).toBe(url);

		await expect(fixture.listener.captureAsync(AbortSignal.any([]))).rejects.toMatchObject({
			code: "capture_rejected",
		});
	});

	it("should end an idle long poll so the plugin can retry", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(2);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const fixture = await fixtureAsync({ onTestFinished });
		const poll = fixture.request(fixture.listener.url);
		await vi.advanceTimersByTimeAsync(20_000);

		await expect(poll.finished).resolves.toMatchObject({ status: 204 });

		const capturing = fixture.listener.captureAsync(AbortSignal.any([]));
		const url = await dispatchedUrlAsync(fixture);
		await fixture.request(url, "POST", [frame('{"services":[]}')]).finished;

		await expect(capturing).resolves.toMatchObject({ services: [] });
	});

	it("should dispose a disconnected poll before dispatching the next capture", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(1);

		const fixture = await fixtureAsync({ onTestFinished });
		fixture.request(fixture.listener.url).close();
		const capturing = fixture.listener.captureAsync(AbortSignal.any([]));
		const url = await dispatchedUrlAsync(fixture);
		await fixture.request(url, "POST", [frame('{"services":[]}')]).finished;

		await expect(capturing).resolves.toMatchObject({ services: [] });
	});

	it("should reject a cancelled bind and a failed bind without leaving a listener", async ({
		expect,
	}) => {
		expect.assertions(3);

		const fake = createCaptureBackend();

		await expect(
			createNodeNetwork(fake.backend).listenForCaptureAsync(IDENTITY, AbortSignal.abort()),
		).rejects.toMatchObject({ name: "AbortError" });

		fake.delayBind();
		const abort = new AbortController();
		const binding = createNodeNetwork(fake.backend).listenForCaptureAsync(
			IDENTITY,
			abort.signal,
		);
		abort.abort();
		fake.bind();

		await expect(binding).rejects.toMatchObject({ name: "AbortError" });

		const failure = createCaptureBackend();
		failure.delayBind();
		const failedBind = createNodeNetwork(failure.backend).listenForCaptureAsync(IDENTITY);
		failure.failBind();

		await expect(failedBind).rejects.toThrow("bind denied");
	});

	it.for([
		{ name: "completed", body: frame('{"services":[]}'), status: 409 },
		{ name: "invalid", body: Buffer.from([0]), status: 400 },
	])(
		"should ignore a late $name post after cancellation",
		async ({ body, status }, { expect, onTestFinished }) => {
			expect.assertions(2);

			const fixture = await fixtureAsync({ onTestFinished });
			const abort = new AbortController();
			const rejected = expect(
				fixture.listener.captureAsync(abort.signal),
			).rejects.toMatchObject({ code: "capture_timeout" });
			const url = await dispatchedUrlAsync(fixture);
			const chunk = Promise.withResolvers<Buffer>();
			const posting = fixture.request(
				url,
				"POST",
				(async function* () {
					yield await chunk.promise;
				})(),
			);
			abort.abort();
			await rejected;
			chunk.resolve(body);

			await expect(posting.finished).resolves.toMatchObject({ status });
		},
	);
});
