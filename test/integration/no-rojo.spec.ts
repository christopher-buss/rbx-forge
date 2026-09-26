/**
 * A real supervisor with `--no-rojo`: the compiler is its only service, so
 * a busy Rojo port does not stop it, and no `rojo serve` runs.
 */
import nodeFs from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";

import { findSession } from "../../src/client/session.ts";
import type { IpcTarget } from "../../src/ipc/client.ts";
import { callSessionAsync } from "../../src/ipc/client.ts";
import type { SessionStatus } from "../../src/session/status.ts";
import { isReady, parseStatus } from "../../src/session/status.ts";
import type { SessionRequest } from "../../src/supervisor/channel.ts";
import { forgeFiles } from "../../src/supervisor/session-files.ts";
import { realTransport } from "../helpers/native-testing.ts";
import { isRojoServe } from "../helpers/worker-log.ts";
import {
	filesLeft,
	launch,
	makeProjectAsync,
	settledWithinAsync,
	waitForAsync,
	workersOf,
} from "./session-harness.ts";

const NO_ROJO: SessionRequest = { compiler: true, config: {}, open: false, rojo: false };
const POLL_MS = 50;
const WAIT_MS = 30_000;

/**
 * Listen on a free port of `127.0.0.1` until the test ends.
 *
 * @returns A port no session can take while the test runs.
 */
async function busyPortAsync(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => {
		server.listen({ host: "127.0.0.1", port: 0 }, resolve);
	});
	onTestFinished(async () => {
		await new Promise((resolve) => {
			server.close(resolve);
		});
	});
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a TCP server's address is an object
	return (server.address() as AddressInfo).port;
}

/**
 * Ask a session for its status until it is ready.
 *
 * @param target - The session's endpoint and token.
 * @returns Its first status with phase `ready`.
 * @rejects When {@link WAIT_MS} pass first.
 */
async function readyStatusAsync(target: IpcTarget): Promise<SessionStatus> {
	const transport = realTransport();
	const deadline = Date.now() + WAIT_MS;
	while (Date.now() < deadline) {
		const status = parseStatus(await callSessionAsync(transport, target, "status"));
		if (status !== undefined && isReady(status)) {
			return status;
		}

		await sleep(POLL_MS);
	}

	throw new Error("the session was never ready");
}

describe("supervisor --no-rojo", () => {
	it("should be ready on a busy Rojo port with the compiler alone, and serve no Rojo", async () => {
		expect.assertions(3);

		const project = await makeProjectAsync({
			projectType: "rbxts",
			rojoPort: await busyPortAsync(),
		});
		const run = launch(project, NO_ROJO);
		const session = await waitForAsync(() => findSession(nodeFs, forgeFiles(project.project)));
		const status = await readyStatusAsync({
			endpoint: session.identity.endpoint,
			token: session.token,
		});
		const serves = workersOf(project, session.identity.sessionId).filter(isRojoServe);
		run.stop("SIGINT");
		const settled = await settledWithinAsync(run, "stop", 30_000);

		expect(status).toMatchObject({
			services: { compiler: { status: "ready" }, rojo: { port: null, status: "off" } },
		});
		expect(serves).toStrictEqual([]);
		expect({ files: filesLeft(project), settled }).toMatchObject({
			files: [],
			settled: { ok: true, result: { data: { port: null, reason: "SIGINT" } } },
		});
	}, 60_000);
});
