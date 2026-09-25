/**
 * IPC security S3 (spec #28): another local user cannot reach a session's
 * control channel. Runs only in CI's `other-user` job, which creates that
 * user (decisions: never on a developer machine). `RBX_FORGE_OTHER_USER`
 * names it; on Windows `RBX_FORGE_OTHER_PASSWORD` holds its password.
 *
 * Each test first proves that the other user can reach an endpoint that
 * lets it in (the control), so a denial is never an artifact of the setup.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import { startIpcServer } from "../../src/ipc/server.ts";
import { endpointFor } from "../../src/supervisor/endpoint.ts";
import { loadTestNative, realTransport } from "../helpers/native-testing.ts";

const IS_WINDOWS = process.platform === "win32";
const ACCESS_DENIED = 5;
const EACCES = "13";

/** Connects to a Unix socket and prints `connected` or the errno. */
const PYTHON_CONNECT = [
	"import socket, sys",
	"s = socket.socket(socket.AF_UNIX)",
	"try:",
	"    s.connect(sys.argv[1])",
	"    print('connected')",
	"except OSError as err:",
	"    print(err.errno)",
].join("\n");

function otherPassword(): string {
	const password = process.env["RBX_FORGE_OTHER_PASSWORD"];
	assert(password !== undefined, "RBX_FORGE_OTHER_PASSWORD holds the other user's password");
	return password;
}

function otherUser(): string {
	const user = process.env["RBX_FORGE_OTHER_USER"];
	assert(user !== undefined && user !== "", "RBX_FORGE_OTHER_USER names the other user");
	return user;
}

/**
 * A directory under `/tmp` that every user may enter, removed at the end.
 *
 * @returns Its path.
 */
function sharedDirectory(): string {
	const directory = mkdtempSync("/tmp/rbx-forge-other-");
	chmodSync(directory, 0o755);
	onTestFinished(() => {
		rmSync(directory, { force: true, recursive: true });
	});
	return directory;
}

async function listenAsync(endpoint: string): Promise<void> {
	const server = createServer();
	await new Promise<void>((resolve) => {
		server.listen(endpoint, resolve);
	});
	onTestFinished(() => {
		server.close();
	});
}

/**
 * Connect to a Unix socket as the other user.
 *
 * @param socket - The socket path.
 * @returns `connected`, or the errno of the failed connect.
 */
function connectAsOther(socket: string): string {
	const run = spawnSync(
		"sudo",
		["-n", "-u", otherUser(), "python3", "-c", PYTHON_CONNECT, socket],
		{ encoding: "utf8" },
	);
	return `${run.stdout}${run.stderr}`.trim();
}

describe("another local user", () => {
	it.skipIf(!IS_WINDOWS)(
		"should be denied the control pipe, though a default pipe lets it in (S3)",
		async () => {
			expect.assertions(2);

			const native = loadTestNative();
			const password = otherPassword();
			const transport = realTransport();
			const endpoint = `\\\\.\\pipe\\rbx-forge-other-${process.pid}`;
			const server = startIpcServer(await transport.listenAsync(endpoint), {
				handlers: {},
				token: "token",
			});
			onTestFinished(async () => {
				await server.closeAsync();
			});
			// A pipe with the default DACL grants read to everyone.
			const control = `${endpoint}-control`;
			await listenAsync(control);

			expect(native.connectPipeAs!(control, otherUser(), password, false)).toBe(0);
			expect([
				native.connectPipeAs!(endpoint, otherUser(), password, false),
				native.connectPipeAs!(endpoint, otherUser(), password, true),
			]).toStrictEqual([ACCESS_DENIED, ACCESS_DENIED]);
		},
	);

	it.skipIf(IS_WINDOWS)(
		"should be denied the control socket, though an open socket lets it in (S3)",
		async () => {
			expect.assertions(2);

			const runtime = sharedDirectory();
			const control = path.join(runtime, "control.sock");
			await listenAsync(control);
			chmodSync(control, 0o777);
			const endpoint = endpointFor({
				buildOutputPath: "game.rbxl",
				env: { XDG_RUNTIME_DIR: runtime },
				platform: process.platform,
				projectRoot: runtime,
				userId: process.getuid!(),
			});
			const server = startIpcServer(await realTransport().listenAsync(endpoint), {
				handlers: {},
				token: "token",
			});
			onTestFinished(async () => {
				await server.closeAsync();
			});

			expect(connectAsOther(control)).toBe("connected");
			expect(connectAsOther(endpoint)).toBe(EACCES);
		},
	);
});
