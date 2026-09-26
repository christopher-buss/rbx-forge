/**
 * Part owners against real supervisors: the `start` that started a session
 * owns its parts over the owner pipe, a `start` that joins owns them over
 * the endpoint, and the owner's end stops what it started and gives back
 * what it took.
 */
import nodeFs from "node:fs";
import { assert, describe, expect, it } from "vitest";

import { findSession } from "../../src/client/session.ts";
import { callSessionAsync, ownSessionAsync } from "../../src/ipc/client.ts";
import type { SessionStatus } from "../../src/session/status.ts";
import { parseStatus } from "../../src/session/status.ts";
import type { SessionRequest } from "../../src/supervisor/channel.ts";
import { forgeFiles } from "../../src/supervisor/session-files.ts";
import { realTransport } from "../helpers/native-testing.ts";
import { isProcessAlive, waitForDeathAsync } from "../helpers/worker-log.ts";
import type { Project } from "./session-harness.ts";
import {
	launch,
	launchUnowned,
	makeProjectAsync,
	ROJO_ONLY,
	waitForAsync,
	waitForReadyAsync,
	workersOf,
} from "./session-harness.ts";

/** The fake compiler as the Luau watch command: it runs until stopped. */
const WATCH = { luau: { watch: { args: ["-w"], command: "rbxtsc" } } };
const COMPILER_ONLY: SessionRequest = { compiler: true, config: {}, open: false, rojo: false };
const WAIT_MS = 20_000;

/**
 * Reach the project's session.
 *
 * @param project - Where it runs.
 * @returns Its endpoint and token, its id, and a status reader.
 */
async function reachAsync(project: Project) {
	const session = await waitForAsync(() => findSession(nodeFs, forgeFiles(project.project)));
	const target = { endpoint: session.identity.endpoint, token: session.token };
	const transport = realTransport();
	return {
		sessionId: session.identity.sessionId,
		statusAsync: async (): Promise<SessionStatus> => {
			const status = parseStatus(await callSessionAsync(transport, target, "status"));
			assert(status !== undefined, "expected a status");
			return status;
		},
		target,
		transport,
	};
}

/**
 * The PID of the first worker of a role, once it started.
 *
 * @param project - Where the session runs.
 * @param sessionId - Whose workers.
 * @param role - Such as `rojo` or `rbxtsc`.
 * @returns Its PID.
 */
async function pidOfRoleAsync(project: Project, sessionId: string, role: string): Promise<number> {
	return waitForAsync(() => {
		return workersOf(project, sessionId).find(({ role: name }) => name === role)?.pid;
	});
}

describe("part owners", () => {
	it("should stop what start started and run on with a part up added, once start goes", async () => {
		expect.assertions(3);

		const project = await makeProjectAsync(WATCH);
		const run = launch(project, ROJO_ONLY);
		await waitForReadyAsync(run);
		const { sessionId, statusAsync, target, transport } = await reachAsync(project);
		await callSessionAsync(transport, target, "addParts", {
			params: { parts: ["compiler"] },
			responseTimeoutMs: WAIT_MS,
		});
		const rojo = await pidOfRoleAsync(project, sessionId, "rojo");
		const compiler = await pidOfRoleAsync(project, sessionId, "rbxtsc");
		run.stop("SIGINT");

		await expect(run.settled).resolves.toMatchObject({
			ok: true,
			result: { data: { ending: false, released: [], sessionId, stopped: ["rojo"] } },
		});
		await expect(statusAsync()).resolves.toMatchObject({
			phase: "ready",
			services: {
				compiler: { owner: null, status: "ready" },
				rojo: { owner: null, status: "off" },
			},
		});
		expect({
			compiler: isProcessAlive(compiler),
			rojo: await waitForDeathAsync([rojo], WAIT_MS),
		}).toStrictEqual({ compiler: true, rojo: [] });
	}, 60_000);

	it("should let a start join an up session, take its compiler, and give it back on release", async () => {
		expect.assertions(3);

		const project = await makeProjectAsync(WATCH);
		const run = launchUnowned(project, COMPILER_ONLY);
		await waitForReadyAsync(run);
		const { sessionId, statusAsync, target, transport } = await reachAsync(project);
		const compiler = await pidOfRoleAsync(project, sessionId, "rbxtsc");
		const owned = await ownSessionAsync(transport, target, {
			params: { parts: ["compiler"] },
			responseTimeoutMs: WAIT_MS,
			signal: AbortSignal.timeout(WAIT_MS * 3),
		});
		assert(owned !== undefined, "the join was not given up");
		const taken = await statusAsync();
		const release = new AbortController();
		const held = owned.holdAsync(release.signal, WAIT_MS);
		release.abort();

		expect(owned.joined).toStrictEqual({ added: [], sessionId, taken: ["compiler"] });
		await expect(held).resolves.toStrictEqual({
			ending: false,
			released: ["compiler"],
			sessionId,
			stopped: [],
			studioLeft: false,
		});

		const after = await statusAsync();

		expect({
			after: after.services.compiler.owner,
			before: taken.services.compiler.owner,
			compiler: isProcessAlive(compiler),
		}).toStrictEqual({ after: null, before: "start", compiler: true });
	}, 60_000);
});
