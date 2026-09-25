/**
 * The control channel over the real endpoint: a native named pipe on
 * Windows, a Unix socket elsewhere (spec #28, Testing: IPC security S1, S2,
 * S4, S5; S3 runs in the `other-user` project in CI).
 */
import { statSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished } from "vitest";

import { callSessionAsync } from "../../src/ipc/client.ts";
import { encodeLine } from "../../src/ipc/protocol.ts";
import type { NativePipeServer, NativeSecurity } from "../../src/native/addon.ts";
import {
	exists,
	loadTestNative,
	realTransport,
	serveEndpointAsync,
} from "../helpers/native-testing.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";

const IS_WINDOWS = process.platform === "win32";
/**
 * Where nothing listens: a pipe nobody made, or a socket path in an empty
 * directory.
 */
const NOWHERE = IS_WINDOWS ? "\\\\.\\pipe\\rbx-forge-nothing-here" : "/nonexistent/ctl.sock";
/** `\\.\`: the local-host prefix of a pipe path. */
const LOCAL_PREFIX = 4;

/**
 * Connect with `node:net` and report how the connect ended.
 *
 * @param endpoint - Where to connect.
 * @returns `connected`, or the error code.
 */
async function tryConnectAsync(endpoint: string): Promise<string> {
	const socket = connect(endpoint);
	onTestFinished(() => {
		socket.destroy();
	});
	return new Promise((resolve) => {
		socket.once("connect", () => {
			resolve("connected");
		});
		socket.once("error", (err: NodeJS.ErrnoException) => {
			resolve(err.code ?? err.message);
		});
	});
}

/**
 * The same pipe through a remote-style path, such as `\\127.0.0.1\pipe\x`.
 *
 * @param endpoint - `\\.\pipe\<name>`.
 * @param host - The host part.
 * @returns The remote-style path.
 */
function remotePath(endpoint: string, host: string): string {
	return `\\\\${host}\\${endpoint.slice(LOCAL_PREFIX)}`;
}

/**
 * Accept and drop every client of a native server until it closes, so each
 * connect finds a listening instance.
 *
 * @param server - A server that accepts remote clients (the control).
 */
async function acceptAllAsync(server: NativePipeServer): Promise<void> {
	for (let client = await server.accept(); client !== null; client = await server.accept()) {
		client.close();
	}
}

/**
 * The owner and entries of a security descriptor, without access masks.
 *
 * @param security - What the addon read back.
 * @returns The owner, the entries' kinds and SIDs, and the protected flag.
 */
function trustees({ aces, owner, protected: isProtected }: NativeSecurity): object {
	return {
		aces: aces.map(({ kind, sid }) => ({ kind, sid })),
		isProtected,
		owner,
	};
}

describe("control channel", () => {
	it("should answer a client with the right token (S1)", async () => {
		expect.assertions(1);

		const transport = realTransport();
		const { endpoint, token } = await serveEndpointAsync(transport);

		await expect(
			callSessionAsync(transport, { endpoint, token }, "status"),
		).resolves.toStrictEqual({ ok: 1 });
	});

	it("should close on a wrong token without an answer, and keep serving (S2)", async () => {
		expect.assertions(3);

		const transport = realTransport();
		const { endpoint, token } = await serveEndpointAsync(transport);
		const connection = await transport.connectAsync(endpoint, 2000);
		await connection!.writeAsync(
			encodeLine({ protocol: 1, token: "wrong", type: "hello" }) +
				encodeLine({ method: "status", params: {}, type: "request" }),
			2000,
		);

		await expect(connection!.readLineAsync(5000)).resolves.toStrictEqual({ type: "closed" });
		await expect(
			callSessionAsync(transport, { endpoint, token: `${token}x` }, "status"),
		).rejects.toMatchObject({ code: "supervisor_unresponsive" });
		await expect(
			callSessionAsync(transport, { endpoint, token }, "status"),
		).resolves.toStrictEqual({ ok: 1 });
	});

	it("should report no session where nothing listens", async () => {
		expect.assertions(1);

		await expect(
			callSessionAsync(realTransport(), { endpoint: NOWHERE, token: "t" }, "status"),
		).rejects.toMatchObject({ code: "not_running" });
	});

	it.skipIf(IS_WINDOWS)(
		"should keep the socket in an owner-only directory and remove it on close",
		async () => {
			expect.assertions(3);

			const { endpoint, server } = await serveEndpointAsync(realTransport());
			const directoryMode = statSync(path.dirname(endpoint)).mode & 0o777;
			const socketMode = statSync(endpoint).mode & 0o777;
			await server.closeAsync();

			expect(directoryMode).toBe(0o700);
			expect(socketMode).toBe(0o600);
			expect(exists(endpoint)).toBeFalse();
		},
	);

	it.skipIf(!IS_WINDOWS)("should refuse to open a pipe name another process holds", async () => {
		expect.assertions(1);

		const transport = realTransport();
		const { endpoint } = await serveEndpointAsync(transport);

		await expect(transport.listenAsync(endpoint)).rejects.toMatchObject({
			code: "endpoint_in_use",
		});
	});

	it.skipIf(!IS_WINDOWS)(
		"should reject remote-style connects, which a remote-accepting pipe allows (S4)",
		async () => {
			expect.assertions(2);

			const { endpoint } = await serveEndpointAsync(realTransport());
			const control = loadTestNative().createPipeServer!(`${endpoint}-control`, false);
			const accepting = acceptAllAsync(control);
			onTestFinished(async () => {
				control.close();
				await accepting;
			});
			// The control proves that the loopback path works on this machine.
			const controls = [];
			const forge = [];
			for (const host of ["127.0.0.1", "localhost"]) {
				controls.push(await tryConnectAsync(remotePath(`${endpoint}-control`, host)));
				forge.push(await tryConnectAsync(remotePath(endpoint, host)));
			}

			expect(controls).toStrictEqual(["connected", "connected"]);
			expect(forge).toStrictEqual(["EPERM", "EPERM"]);
		},
	);

	it.skipIf(!IS_WINDOWS)(
		"should give the pipe and the token file an owner-only DACL (S5)",
		() => {
			expect.assertions(2);

			const native = loadTestNative();
			const user = native.currentUserSid!();
			const server = native.createPipeServer!(
				`\\\\.\\pipe\\rbx-forge-dacl-${process.pid}`,
				true,
			);
			onTestFinished(() => {
				server.close();
			});
			const token = path.join(makeTemporaryDirectory(), "token");
			native.writePrivateFile!(token, "secret");
			const expected = {
				aces: [{ kind: "allow", sid: user }],
				isProtected: true,
				owner: user,
			};

			expect(trustees(server.security())).toStrictEqual(expected);
			expect(trustees(native.fileSecurity!(token))).toStrictEqual(expected);
		},
	);
});
