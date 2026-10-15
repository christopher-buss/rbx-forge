import { type } from "arktype";
import { Buffer } from "node:buffer";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { ForgeError } from "../errors.ts";
import type { NetworkBackend, RojoServerInfo } from "../seams/network.ts";
import type { Capture, CaptureAddress, CaptureListener } from "./protocol.ts";

const metadataSchema = type({
	services: type({ name: "string > 0", roots: "number.integer >= 0[]" }).array(),
});
const MAX_BODY_BYTES = 128 * 1024 * 1024;
const POLL_MS = 20_000;

interface PendingCapture {
	id: string;
	reject: (error: unknown) => void;
	resolve: (capture: Capture) => void;
}

class CaptureEndpoint implements CaptureListener {
	private readonly backend: NetworkBackend;
	private readonly identity: Pick<RojoServerInfo, "projectName" | "sessionId">;
	private readonly polls = new Set<ServerResponse>();
	private readonly server: Server;
	private readonly signal: AbortSignal | undefined;

	private isClosed = false;
	private isConnected = false;
	private isDispatched!: boolean;
	private pending: PendingCapture | undefined;
	private route!: string;

	public captureAsync: CaptureListener["captureAsync"] = async (signal) => {
		signal.throwIfAborted();
		if (this.isClosed || this.pending !== undefined) {
			throw new ForgeError(
				"capture_rejected",
				"A capture is already running or its listener has closed.",
			);
		}

		const result = Promise.withResolvers<Capture>();
		const request: PendingCapture = {
			id: this.backend.randomBytes(16).toString("hex"),
			reject: result.reject,
			resolve: result.resolve,
		};
		this.pending = request;
		this.isDispatched = false;
		const abort = (): void => {
			this.abort(request);
		};

		signal.addEventListener("abort", abort);
		this.dispatch();
		try {
			return await result.promise;
		} finally {
			signal.removeEventListener("abort", abort);
		}
	};
	public close = (): void => {
		if (this.isClosed) {
			return;
		}

		this.isClosed = true;
		this.signal?.removeEventListener("abort", this.close);
		this.pending?.reject(new ForgeError("capture_timeout", "The capture listener closed."));
		this.pending = undefined;
		for (const poll of this.polls) {
			poll.writeHead(204).end();
		}

		// Stryker disable next-line CallExpression: closed listeners cannot
		// dispatch; release references
		this.polls.clear();
		this.server.close();
		this.server.closeAllConnections();
	};
	public url!: string;

	constructor(
		backend: NetworkBackend,
		identity: Pick<RojoServerInfo, "projectName" | "sessionId">,
		signal: AbortSignal | undefined,
	) {
		this.backend = backend;
		this.identity = { projectName: identity.projectName, sessionId: identity.sessionId };
		this.signal = signal;
		this.server = backend.createHttpServer((incoming, response) => {
			this.receive(incoming, response);
		});
	}

	public async bindAsync(address: CaptureAddress | undefined): Promise<void> {
		this.route = `/capture/${address?.secret ?? this.backend.randomBytes(32).toString("hex")}`;
		try {
			await new Promise<void>((resolve, reject) => {
				this.server.once("error", reject);
				this.server.listen({ host: "127.0.0.1", port: address?.port ?? 0 }, resolve);
			});
			this.signal?.throwIfAborted();
			this.url = this.boundUrl();
			this.signal?.addEventListener("abort", this.close);
		} catch (err) {
			this.close();
			throw err;
		}
	}

	private abort(request: PendingCapture): void {
		if (this.pending === request) {
			this.pending = undefined;
		}

		request.reject(
			new ForgeError(
				this.isConnected ? "capture_timeout" : "capture_not_connected",
				this.isConnected
					? "Studio did not finish the capture before the timeout."
					: "The forge plugin is not connected; connect Studio to the session's Rojo.",
			),
		);
	}

	private accept(request: PendingCapture, response: ServerResponse, capture: Capture): void {
		if (this.pending !== request) {
			response.writeHead(409).end();
			return;
		}

		this.pending = undefined;
		response.writeHead(204).end();
		request.resolve(capture);
	}

	private boundUrl(): string {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only a bound endpoint is published
		const { port } = this.server.address() as AddressInfo;
		const query = new URLSearchParams(this.identity);
		return `http://127.0.0.1:${port}${this.route}?${query.toString()}`;
	}

	private dispatch(): void {
		if (this.pending === undefined || this.isDispatched) {
			return;
		}

		const poll = this.polls.values().next().value;
		if (poll === undefined) {
			return;
		}

		this.isDispatched = true;
		this.polls.delete(poll);
		const body = JSON.stringify({ ...this.identity, requestId: this.pending.id });
		poll.writeHead(200, {
			"content-length": Buffer.byteLength(body),
			"content-type": "application/json",
		});
		poll.end(body);
	}

	private isCurrent(url: URL): boolean {
		return (
			url.pathname === this.route &&
			url.searchParams.get("projectName") === this.identity.projectName &&
			url.searchParams.get("sessionId") === this.identity.sessionId
		);
	}

	private poll(response: ServerResponse): void {
		this.isConnected = true;
		this.polls.add(response);
		const timer = setTimeout(() => {
			this.polls.delete(response);
			response.writeHead(204).end();
		}, POLL_MS);
		response.once("close", () => {
			clearTimeout(timer);
			this.polls.delete(response);
		});
		this.dispatch();
	}

	private receive(incoming: IncomingMessage, response: ServerResponse): void {
		const url = requestUrl(incoming);
		if (url === null || this.isClosed || !this.isCurrent(url)) {
			response.writeHead(404).end();
			return;
		}

		if (incoming.method === "GET") {
			this.poll(response);
			return;
		}

		const request = this.pending;
		if (
			request === undefined ||
			!this.isDispatched ||
			incoming.method !== "POST" ||
			url.searchParams.get("requestId") !== request.id
		) {
			response.writeHead(404).end();
			return;
		}

		void readCaptureAsync(incoming)
			.then((capture) => {
				this.accept(request, response, capture);
			})
			.catch((err: unknown) => {
				this.reject(request, response, err);
			});
	}

	private reject(request: PendingCapture, response: ServerResponse, error: unknown): void {
		if (this.pending === request) {
			this.pending = undefined;
			request.reject(
				error instanceof ForgeError
					? error
					: new ForgeError("capture_rejected", "Studio sent an invalid capture.", {
							cause: error,
						}),
			);
		}

		response.writeHead(400).end();
	}
}

/**
 * Bind the plugin's authenticated loopback capture channel.
 * @param backend - HTTP and entropy drivers.
 * @param identity - The connected Rojo project and session.
 * @param signal - Ends the listener with its session.
 * @param address - A snapshot's recorded address.
 * @returns The bound listener.
 * @rejects Binding failure or cancellation.
 */
export async function listenCaptureAsync(
	backend: NetworkBackend,
	identity: Pick<RojoServerInfo, "projectName" | "sessionId">,
	signal?: AbortSignal,
	address?: CaptureAddress,
): Promise<CaptureListener> {
	signal?.throwIfAborted();
	const endpoint = new CaptureEndpoint(backend, identity, signal);
	await endpoint.bindAsync(address);
	return { captureAsync: endpoint.captureAsync, close: endpoint.close, url: endpoint.url };
}

function requestUrl(incoming: IncomingMessage): null | URL {
	return URL.parse(
		// Stryker disable next-line StringLiteral: absent URLs miss the route
		incoming.url ?? "/",
		"http://127.0.0.1",
	);
}

async function readBodyAsync(incoming: IncomingMessage): Promise<Buffer> {
	const body: AsyncIterable<Buffer | string> = incoming;
	const chunks: Array<Buffer> = [];
	let bytes = 0;
	for await (const chunk of body) {
		const part = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		bytes += part.length;
		if (bytes > MAX_BODY_BYTES) {
			throw new ForgeError("capture_rejected", "The capture exceeds the size limit.");
		}

		chunks.push(part);
	}

	return Buffer.concat(chunks);
}

async function readCaptureAsync(incoming: IncomingMessage): Promise<Capture> {
	const body = await readBodyAsync(incoming);
	if (incoming.headers["content-type"] === "application/json") {
		throw new ForgeError("capture_rejected", "Studio rejected the capture.", {
			details: { response: body.toString("utf8") },
		});
	}

	if (body.length < 4) {
		throw new ForgeError("capture_rejected", "The capture frame is incomplete.");
	}

	const size = body.readUInt32LE();
	if (size > body.length - 4) {
		throw new ForgeError("capture_rejected", "The capture metadata is incomplete.");
	}

	const metadata = metadataSchema.assert(JSON.parse(body.subarray(4, 4 + size).toString("utf8")));
	return { ...metadata, model: new Uint8Array(body.subarray(4 + size)) };
}
