/**
 * A session is ready once Rojo listens on its port, not once its process
 * started, with fake Rojo on PATH, the Studio stand-in, and the real reaper.
 */
import { describe, expect, it } from "vitest";

import { EXIT_SUCCESS } from "../../src/exit-codes.ts";
import {
	isListeningAsync,
	makeFixtureAsync,
	START_STUDIO,
	startSession,
	STUDIO_PROJECT,
	waitForOutputAsync,
} from "./session-fixture.ts";
import { runForgeAsync } from "./up-fixture.ts";

/** How long fake Rojo waits before it listens. */
const LISTEN_DELAY_MS = 2000;

describe("session readiness", () => {
	it("should be ready only once Rojo listens on its port", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync(STUDIO_PROJECT, { studio: true });
		const session = startSession(fixture, START_STUDIO, {
			FIXTURE_ROJO_LISTEN_DELAY_MS: String(LISTEN_DELAY_MS),
		});
		await waitForOutputAsync(session, "Press Ctrl+C to stop.");
		const isListening = await isListeningAsync(fixture.port);
		const status = await runForgeAsync(fixture, ["status", "--json"]);

		expect(status.status).toBe(EXIT_SUCCESS);
		expect({ isListening, services: status.result.data!["services"] }).toMatchObject({
			isListening: true,
			services: { rojo: { port: fixture.port, status: "ready" } },
		});
	});
});
