/**
 * `forge up` returns once Rojo listens on its port, not once its process
 * started, with fake Rojo on PATH and the real reaper.
 */
import { connect } from "node:net";
import { describe, expect, it } from "vitest";

import { EXIT_SUCCESS } from "../../src/exit-codes.ts";
import { makeFixtureAsync } from "./session-fixture.ts";
import { runForgeAsync, UP_ROJO_ONLY } from "./up-fixture.ts";

/** How long fake Rojo waits before it listens. */
const LISTEN_DELAY_MS = 2000;

async function isListeningAsync(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port });
		socket.once("error", () => {
			resolve(false);
		});
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
	});
}

describe("forge up readiness", () => {
	it("should return only once Rojo listens on its port", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync();
		const up = await runForgeAsync(fixture, UP_ROJO_ONLY, {
			FIXTURE_ROJO_LISTEN_DELAY_MS: String(LISTEN_DELAY_MS),
		});
		const isListening = await isListeningAsync(fixture.port);

		expect(up.status).toBe(EXIT_SUCCESS);
		expect({ isListening, services: up.result.data!["services"] }).toMatchObject({
			isListening: true,
			services: { rojo: { port: fixture.port, status: "ready" } },
		});
	});
});
