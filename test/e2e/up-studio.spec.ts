/**
 * `forge up --studio` as a real process: it attaches the Studio stand-in and
 * fake Rojo to a session, with the real reaper. Only NDJSON output, exit
 * codes, files, and the process table are checked.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { assert, describe, expect, it } from "vitest";

import { EXIT_FAILURE } from "../../src/exit-codes.ts";
import type { SessionStatus } from "../../src/session/status.ts";
import { parseStatus } from "../../src/session/status.ts";
import { openStudioStandInAsync, pidOf } from "../helpers/real-native.ts";
import { readWorkerLog, waitForDeathAsync } from "../helpers/worker-log.ts";
import type { Fixture } from "./session-fixture.ts";
import { holdPortAsync, makeFixtureAsync } from "./session-fixture.ts";
import type { UpRun } from "./up-fixture.ts";
import { runForgeAsync, UP, WATCH_COMMAND } from "./up-fixture.ts";

const UP_STUDIO = ["up", "--studio", "--json"];
/** A Luau project whose compiler runs in watch mode. */
const PROJECT = { ...WATCH_COMMAND, open: { buildFirst: true } };
/** The same, with no `rojoPort`: the session picks the port. */
const ANY_PORT = { ...PROJECT, rojoPort: undefined };
/** How long a dead process may stay a zombie before its parent reaps it. */
const REAP_MS = 2000;

/**
 * The Rojo part in a run's result.
 *
 * @param run - An `up` or `status` run.
 * @param run.result - Its result line.
 * @returns Rojo's part.
 */
function rojoOf({ result }: UpRun): SessionStatus["services"]["rojo"] {
	const status = parseStatus(result.data);
	assert(status !== undefined, "expected a status");
	return status.services.rojo;
}

/**
 * Every process the fixtures started, as `role args`.
 *
 * @param fixture - The project.
 * @returns The process table, in start order.
 */
function processes(fixture: Fixture): Array<string> {
	return readWorkerLog(fixture.log).map(({ args, role }) => [role, ...args].join(" "));
}

/**
 * The PIDs of the fixture processes with this role.
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

describe("forge up --studio", () => {
	it("should attach Studio and Rojo to a running session, and not restart the compiler", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync(PROJECT, { studio: true });
		await runForgeAsync(fixture, UP);
		const up = await runForgeAsync(fixture, UP_STUDIO);

		expect(up.result).toMatchObject({
			data: {
				added: ["studio", "rojo"],
				services: {
					compiler: { status: "ready" },
					rojo: { port: fixture.port, status: "ready" },
					studio: { owner: null, place: fixture.place, status: "open" },
				},
				started: false,
			},
			ok: true,
		});
		expect(processes(fixture).filter((line) => !line.startsWith("rojo build"))).toStrictEqual([
			"rbxtsc -w",
			expect.stringMatching(/^studio /),
			`rojo serve default.project.json --port ${fixture.port}`,
		]);
	});

	it("should start a session with its compiler, then attach Studio and Rojo", async () => {
		expect.assertions(1);

		const fixture = await makeFixtureAsync(PROJECT, { studio: true });
		const up = await runForgeAsync(fixture, UP_STUDIO);

		expect(up.result).toMatchObject({
			data: {
				added: ["compiler", "studio", "rojo"],
				services: { rojo: { status: "ready" }, studio: { status: "open" } },
				started: true,
			},
			ok: true,
		});
	});

	it("should attach the Studio that has the place open: no build, no second Studio", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync(PROJECT, { studio: true });
		const studio = pidOf(await openStudioStandInAsync(fixture.place));
		const up = await runForgeAsync(fixture, UP_STUDIO);

		expect(up.result.data).toMatchObject({
			services: { studio: { pid: studio, status: "open" } },
		});
		expect(processes(fixture)).toStrictEqual([
			"rbxtsc -w",
			`rojo serve default.project.json --port ${fixture.port}`,
		]);
	});

	it("should serve each worktree with no rojoPort on its own port", async () => {
		expect.assertions(3);

		const first = await makeFixtureAsync(ANY_PORT, { studio: true });
		const second = await makeFixtureAsync(ANY_PORT, { studio: true });
		const one = rojoOf(await runForgeAsync(first, UP_STUDIO));
		const two = rojoOf(await runForgeAsync(second, UP_STUDIO));

		expect([one.status, two.status]).toStrictEqual(["ready", "ready"]);
		expect(one.port).toBeNumber();
		expect(one.port).not.toBe(two.port);
	});

	it("should fail with port_in_use when the set rojoPort is busy, and open no Studio", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync(PROJECT, { studio: true });
		await holdPortAsync(fixture.port);
		const up = await runForgeAsync(fixture, UP_STUDIO);

		expect([up.status, up.result.error]).toMatchObject([EXIT_FAILURE, { code: "port_in_use" }]);
		// The compiler may not have written its record yet; nothing else ran.
		expect(processes(fixture).filter((line) => line !== "rbxtsc -w")).toStrictEqual([]);
	});

	it("should stop only Rojo when the attached Studio closes, and attach again on the same port", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync(ANY_PORT, { studio: true });
		const first = rojoOf(await runForgeAsync(fixture, UP_STUDIO));
		const rojo = pidsOf(fixture, "rojo");
		const stop = await runForgeAsync(fixture, ["stop", "--json"]);
		const closed = await waitForStatusAsync(
			fixture,
			({ services }) => services.rojo.status === "off",
		);
		const again = rojoOf(await runForgeAsync(fixture, UP_STUDIO));

		expect(stop.result.ok).toBeTrue();
		expect(closed.services).toMatchObject({
			compiler: { status: "ready" },
			studio: { status: "closed" },
		});
		await expect(waitForDeathAsync(rojo, REAP_MS)).resolves.toStrictEqual([]);
		expect(again).toMatchObject({ port: first.port, status: "ready" });
	});

	it("should start a failed Rojo again on the same port with up", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync(ANY_PORT, { studio: true });
		const exits = { FIXTURE_EXIT_AFTER_MS: "3000", FIXTURE_EXIT_ROLE: "rojo" };
		const { port } = rojoOf(await runForgeAsync(fixture, UP_STUDIO, exits));
		await waitForStatusAsync(fixture, ({ services }) => services.rojo.status === "failed");
		const repair = await runForgeAsync(fixture, UP);

		expect(repair.result.data).toMatchObject({
			added: ["rojo"],
			services: { rojo: { port, status: "ready" } },
		});
		expect(processes(fixture).filter((line) => line.startsWith("rojo serve"))).toStrictEqual([
			`rojo serve default.project.json --port ${String(port)}`,
			`rojo serve default.project.json --port ${String(port)}`,
		]);
	});
});
