/**
 * `forge start` as the owner of a session's parts, as real processes: it
 * joins an agent's `up` session, and `down`, `stop`, and `stop --force` from
 * other processes meet its parts. Only NDJSON output, exit codes, and the
 * process table are checked.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { assert, describe, expect, it } from "vitest";

import { EXIT_FAILURE, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import type { SessionStatus } from "../../src/session/status.ts";
import { parseStatus } from "../../src/session/status.ts";
import { parseResult } from "../helpers/output.ts";
import { isProcessAlive, readWorkerLog, waitForDeathAsync } from "../helpers/worker-log.ts";
import type { Fixture } from "./session-fixture.ts";
import {
	IS_WINDOWS,
	makeFixtureAsync,
	startReadyAsync,
	waitForRoleAsync,
} from "./session-fixture.ts";
import { runForgeAsync, UP, WATCH_COMMAND } from "./up-fixture.ts";

/** A Luau project whose compiler runs in watch mode. */
const PROJECT = { ...WATCH_COMMAND, open: { buildFirst: true } };
const START = ["start", "--json"];
/** How long a dead process may stay a zombie before its parent reaps it. */
const REAP_MS = 5000;

/**
 * Run `forge status --json` until `isDone` holds for the status.
 *
 * @param fixture - The project and its environment.
 * @param isDone - The condition.
 * @returns That status.
 * @rejects When 30 seconds pass first.
 */
async function waitForStatusAsync(
	fixture: Fixture,
	isDone: (status: SessionStatus) => boolean,
): Promise<SessionStatus> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const { result } = await runForgeAsync(fixture, ["status", "--json"]);
		const status = parseStatus(result.data);
		if (status !== undefined && isDone(status)) {
			return status;
		}

		assert(Date.now() < deadline, "the status never came");
		await sleep(100);
	}
}

/**
 * The PIDs of the long-running fixture processes with this role.
 *
 * @param fixture - The project.
 * @param role - Such as `rojo`.
 * @returns Their PIDs, in start order.
 */
function pidsOf(fixture: Fixture, role: string): Array<number> {
	return readWorkerLog(fixture.log)
		.filter((record) => record.role === role && record.args[0] !== "build")
		.map(({ pid }) => pid);
}

function ownersOf({ services }: SessionStatus): Record<string, unknown> {
	return {
		compiler: [services.compiler.owner, services.compiler.status],
		rojo: [services.rojo.owner, services.rojo.status],
		studio: [services.studio.owner, services.studio.status],
	};
}

describe("forge start next to an agent's session", () => {
	it("should take the agent's compiler without a restart, add Studio and Rojo, and keep them from down and stop", async () => {
		expect.assertions(5);

		const fixture = await makeFixtureAsync(PROJECT, { studio: true });
		await runForgeAsync(fixture, UP);
		const { pid: compiler } = await waitForRoleAsync(fixture.log, "rbxtsc");
		await startReadyAsync(fixture, START);
		const owned = await waitForStatusAsync(fixture, (status) => {
			return status.services.studio.status === "open";
		});
		const down = await runForgeAsync(fixture, ["down", "--json"]);
		const stop = await runForgeAsync(fixture, ["stop", "--json"]);

		expect(ownersOf(owned)).toStrictEqual({
			compiler: ["start", "ready"],
			rojo: ["start", "ready"],
			studio: ["start", "open"],
		});
		expect(down.result).toMatchObject({
			data: {
				parts: {
					kept: [
						{ owner: "start", part: "studio" },
						{ owner: "start", part: "rojo" },
						{ owner: "start", part: "compiler" },
					],
					stopped: [],
				},
				status: "running",
			},
			ok: true,
		});
		expect([stop.status, stop.result.error]).toMatchObject([
			EXIT_FAILURE,
			{ code: "studio_owned", details: { owner: "start" } },
		]);
		expect(pidsOf(fixture, "rbxtsc")).toStrictEqual([compiler]);
		expect(isProcessAlive(compiler)).toBeTrue();
	});

	it("should take only the compiler with --no-open, and leave the agent's Studio and Rojo to stop", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync(PROJECT, { studio: true });
		await runForgeAsync(fixture, [...UP, "--studio"]);
		await startReadyAsync(fixture, ["start", "--no-open", "--json"]);
		const owned = await waitForStatusAsync(fixture, (status) => {
			return status.services.compiler.owner === "start";
		});
		const stop = await runForgeAsync(fixture, ["stop", "--json"]);

		expect(ownersOf(owned)).toStrictEqual({
			compiler: ["start", "ready"],
			rojo: [null, "ready"],
			studio: [null, "open"],
		});
		expect(stop.result).toMatchObject({
			data: { parts: { kept: [], stopped: ["studio", "rojo"] }, stopped: true },
			ok: true,
		});
		expect(stop.status).toBe(EXIT_SUCCESS);
	});

	it("should stop what it added and give back what it took once it is killed, leaving Studio open", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync(PROJECT, { studio: true });
		await runForgeAsync(fixture, UP);
		const { pid: compiler } = await waitForRoleAsync(fixture.log, "rbxtsc");
		const { session } = await startReadyAsync(fixture, START);
		const studio = await waitForRoleAsync(fixture.log, "studio");
		const rojo = pidsOf(fixture, "rojo");
		session.child.kill("SIGKILL");
		await session.closed;
		const released = await waitForStatusAsync(fixture, (status) => {
			return status.services.compiler.owner === null;
		});

		expect(ownersOf(released)).toStrictEqual({
			compiler: [null, "ready"],
			rojo: [null, "off"],
			studio: [null, "off"],
		});
		await expect(waitForDeathAsync(rojo, REAP_MS)).resolves.toStrictEqual([]);
		expect({
			compiler: isProcessAlive(compiler),
			studio: isProcessAlive(studio.pid),
		}).toStrictEqual({ compiler: true, studio: true });

		const down = await runForgeAsync(fixture, ["down", "--json"]);

		expect(down.result.data).toMatchObject({
			parts: { kept: [], stopped: ["compiler"] },
			status: "stopped",
		});
	});

	// Windows cannot send SIGINT to another process: `kill` terminates it.
	it.skipIf(IS_WINDOWS)("should report what it let go of on Ctrl+C", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync(PROJECT, { studio: true });
		await runForgeAsync(fixture, UP);
		const { session, sessionId } = await startReadyAsync(fixture, START);
		session.child.kill("SIGINT");
		const status = await session.closed;

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseResult(session.stdout())).toMatchObject({
			data: {
				ending: false,
				released: ["compiler"],
				sessionId,
				stopped: ["rojo"],
				studioLeft: true,
			},
			ok: true,
		});
	});

	it("should refuse to join a session another start owns", async () => {
		expect.assertions(1);

		const fixture = await makeFixtureAsync(PROJECT, { studio: true });
		await startReadyAsync(fixture, ["start", "--no-open", "--json"]);
		const second = await runForgeAsync(fixture, ["start", "--no-open", "--json"]);

		expect([second.status, second.result.error]).toMatchObject([
			EXIT_FAILURE,
			{ code: "session_running" },
		]);
	});
});

describe("forge stop --force on a Studio a start owns", () => {
	it("should close it, and keep the start session, which ends on its owner's end", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync(PROJECT, { studio: true });
		const { session } = await startReadyAsync(fixture, ["start", "--no-compiler", "--json"]);
		const studio = await waitForRoleAsync(fixture.log, "studio");
		await waitForStatusAsync(fixture, ({ services }) => services.studio.status === "open");
		const stop = await runForgeAsync(fixture, ["stop", "--force", "--json"]);
		const after = await waitForStatusAsync(fixture, () => true);

		expect(stop.result).toMatchObject({
			data: { parts: { kept: [], stopped: ["studio", "rojo"] } },
			ok: true,
		});
		expect({ phase: after.phase, start: session.child.exitCode }).toStrictEqual({
			phase: "ready",
			start: null,
		});
		await expect(waitForDeathAsync([studio.pid], REAP_MS)).resolves.toStrictEqual([]);
	});
});
