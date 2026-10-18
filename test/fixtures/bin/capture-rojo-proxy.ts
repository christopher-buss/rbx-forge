/**
 * Genuine Rojo behind an owned transport that a real-Studio test can
 * disconnect.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Server, Socket } from "node:net";
import { connect, createServer } from "node:net";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const EXECUTABLE = environmentVariable("FORGE_CAPTURE_TEST_ROJO");
const DISCONNECTED = environmentVariable("FORGE_CAPTURE_TEST_DISCONNECT");
const args = process.argv.slice(2);
const HOST_HEADER = /^host:[^\r\n]*/imu;
const CONNECTION_HEADER = /^connection:[^\r\n]*/imu;
const UPGRADE_HEADER = /^upgrade:/imu;

function environmentVariable(name: string): string {
	const value = process.env[name];
	assert(value !== undefined);
	return value;
}

async function portAsync(server: Server, port = 0): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address !== null && typeof address !== "string");
	return address.port;
}

async function freePortAsync(): Promise<number> {
	const server = createServer();
	const port = await portAsync(server);
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error !== undefined) {
				reject(error);
				return;
			}

			resolve();
		});
	});
	return port;
}

async function readyAsync(port: number): Promise<void> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/rojo`);
			if (response.ok) {
				return;
			}
		} catch {
			// The owned child is still starting.
		}

		assert(Date.now() < deadline, "Genuine test Rojo did not start");
		await sleep(25);
	}
}

function rewriteHeaders(value: string, port: number): string {
	// Rojo validates the bound port in Host; upgraded WebSockets stay
	// byte-for-byte streams.
	const headers = value.replace(HOST_HEADER, () => `Host: 127.0.0.1:${port}`);
	if (UPGRADE_HEADER.test(headers)) {
		return headers;
	}

	return CONNECTION_HEADER.test(headers)
		? headers.replace(CONNECTION_HEADER, "Connection: close")
		: `${headers}\r\nConnection: close`;
}

function forwardHeaders(socket: Socket, upstream: Socket, port: number): void {
	let prefix = Buffer.alloc(0);
	function receive(chunk: Buffer): void {
		prefix = Buffer.concat([prefix, chunk]);
		const end = prefix.indexOf("\r\n\r\n");
		if (end < 0) {
			return;
		}

		socket.removeListener("data", receive);
		upstream.write(`${rewriteHeaders(prefix.subarray(0, end).toString("utf8"), port)}\r\n\r\n`);
		upstream.write(prefix.subarray(end + 4));
		socket.pipe(upstream).pipe(socket);
	}

	socket.on("data", receive);
}

function proxySocket(socket: Socket, port: number, sockets: Set<Socket>): void {
	if (existsSync(DISCONNECTED)) {
		socket.destroy();
		return;
	}

	const upstream = connect({ host: "127.0.0.1", port });
	for (const peer of [socket, upstream]) {
		sockets.add(peer);
		peer.on("error", () => {
			socket.destroy();
			upstream.destroy();
		});
		peer.on("close", () => {
			sockets.delete(peer);
		});
	}

	socket.once("close", () => {
		upstream.destroy();
	});
	upstream.once("close", () => {
		socket.destroy();
	});
	forwardHeaders(socket, upstream, port);
}

async function serveAsync(
	port: number,
	advertised: number,
	exited: Promise<number>,
): Promise<void> {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		proxySocket(socket, port, sockets);
	});
	await readyAsync(port);
	await portAsync(server, advertised);
	const timer = setInterval(() => {
		if (existsSync(DISCONNECTED)) {
			for (const socket of sockets) {
				socket.destroy();
			}
		}
	}, 25);
	process.exitCode = await exited;
	clearInterval(timer);
	server.close();
	for (const socket of sockets) {
		socket.destroy();
	}
}

async function runAsync(): Promise<void> {
	const portIndex = args.indexOf("--port");
	const isServing = args[0] === "serve";
	const port = isServing ? await freePortAsync() : 0;
	const childArgs = [...args];
	if (isServing) {
		childArgs[portIndex + 1] = String(port);
	}

	const child = spawn(EXECUTABLE, childArgs, { stdio: "inherit", windowsHide: true });
	const exited = new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => {
			resolve(code ?? 1);
		});
	});
	if (!isServing) {
		process.exitCode = await exited;
		return;
	}

	assert(portIndex > 0);
	await serveAsync(port, Number(args[portIndex + 1]), exited);
}

await runAsync();
