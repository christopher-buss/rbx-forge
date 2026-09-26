/**
 * `forge start` attaches a Studio that already has the place open: no build
 * of the place, no second Studio, and the session records and watches that
 * Studio (#50).
 */
import nodeFs from "node:fs";
import { describe, expect, it } from "vitest";

import { findSession } from "../../src/client/session.ts";
import { forgeFiles } from "../../src/supervisor/session-files.ts";
import { openStudioStandInAsync, pidOf } from "../helpers/real-native.ts";
import { readWorkerLog, waitForDeathAsync } from "../helpers/worker-log.ts";
import type { Fixture } from "./session-fixture.ts";
import {
	makeFixtureAsync,
	startReadyAsync,
	startSession,
	waitForOutputAsync,
} from "./session-fixture.ts";
import { runForgeAsync } from "./up-fixture.ts";

/** Rojo and Studio; the open step would build the place first. */
const BUILD_FIRST = { open: { buildFirst: true } };
const START = ["start", "--no-compiler", "--json"];
const OPEN_TEXT = "Roblox Studio has ";

function rolesOf(fixture: Fixture): Array<string> {
	return readWorkerLog(fixture.log).map(({ args, role }) => [role, ...args].join(" "));
}

describe("attach an open Studio", () => {
	it("should attach the Studio that has the place open on start, and close it on stop --force", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync(BUILD_FIRST, { studio: true });
		const studio = pidOf(await openStudioStandInAsync(fixture.place));
		const { session } = await startReadyAsync(fixture, START);
		const stop = await runForgeAsync(fixture, ["stop", "--force", "--json"]);

		// The start that owns the session holds it until its own end.
		expect(session.child.exitCode).toBeNull();
		expect(stop.result).toMatchObject({
			data: { pid: studio, place: fixture.place, stopped: true },
			ok: true,
		});
		// No build under the open Studio, and no second Studio.
		expect(rolesOf(fixture).filter((role) => !role.startsWith("rojo serve"))).toStrictEqual([]);
	});

	it("should attach the Studio a start left open, when start runs again", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync(BUILD_FIRST, { studio: true });
		const first = startSession(fixture, START);
		await waitForOutputAsync(first, OPEN_TEXT);
		const supervisor = findSession(nodeFs, forgeFiles(fixture.project))!.identity.pid;
		first.child.kill();
		await first.closed;
		await waitForDeathAsync([supervisor]);

		const second = startSession(fixture, START);
		await waitForOutputAsync(second, OPEN_TEXT);
		const [studio] = readWorkerLog(fixture.log).filter(({ role }) => role === "studio");
		const place = JSON.stringify(fixture.place).slice(1, -1);

		expect(second.stdout()).toContain(
			`Roblox Studio (PID ${studio!.pid}) already has ${place} open, so the session uses it.`,
		);
		// One build and one Studio, both from the first start.
		expect(rolesOf(fixture).filter((role) => !role.startsWith("rojo serve"))).toStrictEqual([
			expect.stringMatching(/^rojo build /),
			expect.stringMatching(/^studio/),
		]);
	});
});
