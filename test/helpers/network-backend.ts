import { fromAny } from "@total-typescript/shoehorn";

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { vi } from "vitest";
import type { Mock } from "vitest";

import type { NetworkBackend } from "../../src/seams/network.ts";

/** Controls the HTTP driver without binding a socket. */
export interface FakeNetworkBackend {
	backend: NetworkBackend;
	bind: () => void;
	delayBind: () => void;
	failBind: () => void;
	fetch: Mock<NetworkBackend["fetch"]>;
	request: (url: string, method?: string) => number | undefined;
	server: EventEmitter & {
		address: () => { port: number };
		close: Mock<() => void>;
		closeAllConnections: Mock<() => void>;
		listen: Mock<(options: { host: string; port: number }, callback: () => void) => void>;
	};
}

/**
 * Supply deterministic HTTP and entropy drivers without a socket.
 *
 * @returns The backend and its request, bind, and disposal controls.
 */
export function createFakeNetworkBackend(): FakeNetworkBackend {
	let request: (request: IncomingMessage, response: ServerResponse) => void;
	const binding = createFakeBinding();
	const fetch = vi.fn<NetworkBackend["fetch"]>();
	const backend: NetworkBackend = {
		createHttpServer: fromAny((listener: typeof request) => {
			request = listener;
			return binding.server;
		}),
		fetch,
		randomBytes: fromAny((size: number) => Buffer.alloc(size, 0xab)),
	};
	return {
		backend,
		...binding,
		fetch,
		request: (url: string, method = "GET") => receiveRequest(request, url, method),
	};
}

/**
 * Complete a modeled HTTP request through the registered server handler.
 *
 * @param request - The server's handler.
 * @param url - The client URL.
 * @param method - The HTTP method.
 * @returns The completed response status, or undefined before response end.
 */
function receiveRequest(
	request: (incoming: IncomingMessage, response: ServerResponse) => void,
	url: string,
	method: string,
): number | undefined {
	const location = new URL(url);
	const response = { end: vi.fn<() => void>(), writeHead: vi.fn<(status: number) => void>() };
	request(fromAny({ method, url: location.pathname + location.search }), fromAny(response));
	return response.end.mock.calls.length === 0 ? undefined : response.writeHead.mock.calls[0]?.[0];
}

/**
 * Control when the HTTP driver publishes or rejects its binding.
 *
 * @returns The in-memory server and binding controls.
 */
function createFakeBinding(): Pick<
	FakeNetworkBackend,
	"bind" | "delayBind" | "failBind" | "server"
> {
	const emitter = new EventEmitter();
	const bound = Promise.withResolvers<void>();
	let isAutomaticBind = true;
	const server = Object.assign(emitter, {
		address: () => ({ port: 50001 }),
		close: vi.fn<() => void>(),
		closeAllConnections: vi.fn<() => void>(),
		listen: vi.fn((_options: { host: string; port: number }, callback: () => void) => {
			void bound.promise.then(callback);
			if (isAutomaticBind) {
				bound.resolve();
			}
		}),
	});
	return {
		bind: bound.resolve,
		delayBind: () => {
			isAutomaticBind = false;
		},
		failBind: () => {
			emitter.emit("error", new Error("bind denied"));
		},
		server,
	};
}
