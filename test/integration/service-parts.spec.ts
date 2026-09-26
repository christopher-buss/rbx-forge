/**
 * A service's exit against a real supervisor: only its part fails, with its
 * exit code and the end of its output, and the session and the other
 * service keep running.
 */
import nodeFs, { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { assert, describe, expect, it } from "vitest";

import { findSession } from "../../src/client/session.ts";
import { callSessionAsync } from "../../src/ipc/client.ts";
import type { SessionStatus } from "../../src/session/status.ts";
import { parseStatus } from "../../src/session/status.ts";
import type { SessionRequest } from "../../src/supervisor/channel.ts";
import { forgeFiles } from "../../src/supervisor/session-files.ts";
import { realTransport } from "../helpers/native-testing.ts";
import { isProcessAlive } from "../helpers/worker-log.ts";
import { launch, makeProjectAsync, waitForAsync, workersOf } from "./session-harness.ts";

const WITH_COMPILER: SessionRequest = { compiler: true, config: {}, open: false };
const POLL_MS = 50;
const WAIT_MS = 20_000;

/**
 * Start a session with Rojo and a watch-mode compiler, whose `role` exits
 * with code 7 after 1.5 s, and wait until that part has failed.
 *
 * @param role - `rojo` or `rbxtsc`.
 * @returns The status once the part failed, the live workers by role, and
 *   how the supervisor ends.
 */
async function crashAsync(role: string) {
	const project = await makeProjectAsync({ projectType: "rbxts" });
	const watched = path.join(project.project, "src", "main.ts");
	mkdirSync(path.dirname(watched), { recursive: true });
	writeFileSync(watched, "export {};\n");
	const run = launch(project, WITH_COMPILER, {
		FIXTURE_COMPILER_WATCH: watched,
		FIXTURE_EXIT_AFTER_CODE: "7",
		FIXTURE_EXIT_AFTER_MS: "1500",
		FIXTURE_EXIT_ROLE: role,
	});
	const session = await waitForAsync(() => findSession(nodeFs, forgeFiles(project.project)));
	const target = { endpoint: session.identity.endpoint, token: session.token };
	const transport = realTransport();
	const part = role === "rojo" ? "rojo" : "compiler";
	const deadline = Date.now() + WAIT_MS;
	let status: SessionStatus | undefined;
	while (status?.services[part].status !== "failed") {
		assert(Date.now() < deadline, `the ${part} part never failed`);
		await sleep(POLL_MS);
		status = parseStatus(await callSessionAsync(transport, target, "status"));
	}

	const alive = workersOf(project, session.identity.sessionId)
		.filter(({ pid }) => isProcessAlive(pid))
		.map(({ args, role: name }) => (args.includes("-w") ? `${name} -w` : name));
	return { alive, run, status };
}

describe("a service's exit", () => {
	it("should fail only Rojo's part, and keep the session and the compiler running", async () => {
		expect.assertions(4);

		const { alive, run, status } = await crashAsync("rojo");
		run.stop("SIGINT");

		expect(status).toMatchObject({
			phase: "ready",
			running: true,
			services: {
				compiler: { owner: null, status: "ready" },
				rojo: {
					exitCode: 7,
					owner: null,
					status: "failed",
				},
			},
		});
		expect(status.services.rojo.outputTail).toContain("rojo exits on its own");
		expect(alive).toContain("rbxtsc -w");
		await expect(run.settled).resolves.toMatchObject({
			ok: true,
			result: { data: { reason: "SIGINT" } },
		});
	}, 60_000);

	it("should fail only the compiler's part, and keep Rojo serving", async () => {
		expect.assertions(3);

		const { alive, run, status } = await crashAsync("rbxtsc");
		run.stop("SIGINT");

		expect(status).toMatchObject({
			phase: "ready",
			running: true,
			services: {
				compiler: {
					exitCode: 7,
					status: "failed",
				},
				rojo: { status: "ready" },
			},
		});
		expect(status.services.compiler.outputTail).toContain("rbxtsc exits on its own");
		expect(alive).toContain("rojo");
	}, 60_000);
});
