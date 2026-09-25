import { fromAny } from "@total-typescript/shoehorn";

import { EventEmitter } from "node:events";
import type { AddressInfo, Server } from "node:net";
import { connect, createServer } from "node:net";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createFakeNative } from "../../test/helpers/native.ts";
import type { NativePipeServer } from "../native/addon.ts";
import type { NodeTransportBackend } from "./transport.ts";
import { createNodeTransport } from "./transport.ts";

const ENDPOINT = path.posix.join("/run", "rbx-forge-1000-key", "ctl.sock");
const DIRECTORY = path.posix.dirname(ENDPOINT);

interface FakeStat {
	isDirectory: boolean;
	mode: number;
	uid: number;
}

/**
 * A `node:net` server stand-in: `listen` succeeds or fails at once.
 *
 * @param error - What `listen` fails with; it succeeds when missing.
 * @returns An event emitter with `listen` and `close`.
 */
function fakeServer(error?: Error): Server {
	const server = Object.assign(new EventEmitter(), {
		close: vi.fn<() => void>(),
		listen: vi.fn<(endpoint: string, done: () => void) => void>((_endpoint, done) => {
			if (error === undefined) {
				done();
			} else {
				server.emit("error", error);
			}
		}),
	});
	return fromAny(server);
}

function posixBackend(
	stat: FakeStat | undefined,
	options: { listenError?: Error; mkdirError?: string } = {},
): NodeTransportBackend & { server: Server } {
	const server = fakeServer(options.listenError);
	return {
		fileSystem: {
			chmodSync: vi.fn<NodeTransportBackend["fileSystem"]["chmodSync"]>(),
			lstatSync: fromAny(
				vi.fn(() => {
					return {
						isDirectory: () => stat?.isDirectory ?? true,
						mode: stat?.mode ?? 0o40_700,
						uid: stat?.uid ?? 1000,
					};
				}),
			),
			mkdirSync: vi.fn<NodeTransportBackend["fileSystem"]["mkdirSync"]>(() => {
				if (options.mkdirError !== undefined) {
					throw Object.assign(new Error(options.mkdirError), {
						code: options.mkdirError,
					});
				}
			}),
			rmSync: vi.fn<NodeTransportBackend["fileSystem"]["rmSync"]>(),
		},
		native: () => createFakeNative().addon,
		net: {
			connect: vi.fn<NodeTransportBackend["net"]["connect"]>(),
			createServer: () => server,
		},
		platform: "linux",
		server,
		userId: 1000,
	};
}

describe(createNodeTransport, () => {
	it("should make an owner-only directory, replace a stale socket, and listen", async () => {
		expect.assertions(4);

		const backend = posixBackend(undefined);
		const listener = await createNodeTransport(backend).listenAsync(ENDPOINT);
		listener.close();

		expect(backend.fileSystem.mkdirSync).toHaveBeenCalledWith(DIRECTORY, { mode: 0o700 });
		expect(backend.fileSystem.rmSync).toHaveBeenCalledWith(ENDPOINT, { force: true });
		expect(backend.server.listen).toHaveBeenCalledWith(ENDPOINT, expect.any(Function));
		expect(backend.fileSystem.chmodSync).toHaveBeenCalledExactlyOnceWith(ENDPOINT, 0o600);
	});

	it("should reset the mode of an existing directory of this user", async () => {
		expect.assertions(1);

		const backend = posixBackend(
			{ isDirectory: true, mode: 0o40_755, uid: 1000 },
			{ mkdirError: "EEXIST" },
		);
		await createNodeTransport(backend).listenAsync(ENDPOINT);

		expect(backend.fileSystem.chmodSync).toHaveBeenCalledWith(DIRECTORY, 0o700);
	});

	it.for([
		["another user's directory", { isDirectory: true, mode: 0o40_700, uid: 0 }],
		["a file", { isDirectory: false, mode: 0o100_700, uid: 1000 }],
	] as const)("should refuse %s", async ([, stat]) => {
		expect.assertions(2);

		const backend = posixBackend(stat, { mkdirError: "EEXIST" });

		await expect(createNodeTransport(backend).listenAsync(ENDPOINT)).rejects.toMatchObject({
			code: "endpoint_in_use",
			hint: "Another program uses it. Stop that program, then start again.",
			message: `Cannot open the control endpoint ${ENDPOINT}: ${DIRECTORY} is not a directory of this user.`,
		});
		expect(backend.server.listen).not.toHaveBeenCalled();
	});

	it("should refuse when the directory cannot be made or the socket cannot listen", async () => {
		expect.assertions(2);

		const noDirectory = posixBackend(undefined, { mkdirError: "EACCES" });
		const noListen = posixBackend(undefined, { listenError: new Error("EADDRINUSE") });

		await expect(createNodeTransport(noDirectory).listenAsync(ENDPOINT)).rejects.toMatchObject({
			cause: { code: "EACCES" },
			code: "endpoint_in_use",
			message: `Cannot open the control endpoint ${ENDPOINT}: its directory cannot be created.`,
		});
		await expect(createNodeTransport(noListen).listenAsync(ENDPOINT)).rejects.toThrow(
			`Cannot open the control endpoint ${ENDPOINT}: EADDRINUSE`,
		);
	});

	it("should open a native pipe server on Windows", async () => {
		expect.assertions(2);

		const server: NativePipeServer = {
			accept: vi.fn<NativePipeServer["accept"]>().mockResolvedValue(null),
			close: vi.fn<NativePipeServer["close"]>(),
			security: vi.fn<NativePipeServer["security"]>(),
		};
		const createPipeServer = vi.fn<(path: string, reject: boolean) => NativePipeServer>();
		createPipeServer.mockReturnValue(server);
		const backend = posixBackend(undefined);
		const listener = await createNodeTransport({
			...backend,
			native: () => ({ ...createFakeNative().addon, createPipeServer }),
			platform: "win32",
			userId: undefined,
		}).listenAsync("\\\\.\\pipe\\rbx-forge-key");

		await expect(listener.acceptAsync()).resolves.toBeUndefined();
		expect(createPipeServer).toHaveBeenCalledExactlyOnceWith(
			"\\\\.\\pipe\\rbx-forge-key",
			true,
		);
	});

	it("should report a pipe another process holds", async () => {
		expect.assertions(1);

		const backend = posixBackend(undefined);
		const transport = createNodeTransport({
			...backend,
			native: () => {
				return {
					...createFakeNative().addon,
					createPipeServer: () => {
						throw new Error("Access is denied.");
					},
				};
			},
			platform: "win32",
		});

		await expect(transport.listenAsync("\\\\.\\pipe\\x")).rejects.toMatchObject({
			code: "endpoint_in_use",
			message:
				"Cannot open the control endpoint \\\\.\\pipe\\x: another process holds the pipe.",
		});
	});

	it("should connect a client, or report that nothing listens", async () => {
		expect.assertions(3);

		const server = createServer((socket) => {
			socket.end("hello\n");
		});
		await new Promise<void>((resolve) => {
			server.listen({ host: "127.0.0.1", port: 0 }, resolve);
		});
		onTestFinished(() => {
			server.close();
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a TCP server's address is an object
		const { port } = server.address() as AddressInfo;
		const transport = createNodeTransport({
			...posixBackend(undefined),
			net: {
				connect: (endpoint) => connect({ host: "127.0.0.1", port: Number(endpoint) }),
				createServer,
			},
		});
		const connection = await transport.connectAsync(String(port), 2000);
		const refused = await transport.connectAsync("1", 2000);

		await expect(connection!.readLineAsync(1000)).resolves.toStrictEqual({
			line: "hello",
			type: "line",
		});
		expect(refused).toBeUndefined();

		connection!.close();

		expect(connection).toBeDefined();
	});

	it.for([
		["connect", 0],
		["error", 1],
	] as const)(
		"should leave no timer behind once the connect ends with %s",
		async ([event, destroys]) => {
			expect.assertions(2);

			vi.useFakeTimers();
			onTestFinished(() => {
				vi.useRealTimers();
			});
			const socket = Object.assign(new EventEmitter(), {
				destroy: vi.fn<() => void>(),
				end: vi.fn<() => void>(),
				on: EventEmitter.prototype.on,
				setEncoding: vi.fn<() => void>(),
			});
			const transport = createNodeTransport({
				...posixBackend(undefined),
				net: { connect: () => fromAny(socket), createServer },
			});
			const connecting = transport.connectAsync("x", 60_000);
			socket.emit(event, new Error(event));
			await connecting;

			expect(vi.getTimerCount()).toBe(0);
			expect(socket.destroy).toHaveBeenCalledTimes(destroys);
		},
	);

	it("should give up on a connect that does not finish in time", async () => {
		expect.assertions(2);

		const socket = Object.assign(new EventEmitter(), { destroy: vi.fn<() => void>() });
		const transport = createNodeTransport({
			...posixBackend(undefined),
			net: { connect: () => fromAny(socket), createServer },
		});

		await expect(transport.connectAsync("x", 10)).resolves.toBeUndefined();
		expect(socket.destroy).toHaveBeenCalledOnce();
	});
});
