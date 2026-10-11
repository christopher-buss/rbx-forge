/**
 * Windows-only opt-in: RBX_FORGE_TEST_REAL_STUDIO=1, logged-in Studio, genuine
 * Rojo 7.7.1 (optionally RBX_FORGE_TEST_REAL_ROJO, an absolute executable
 * path). Opens desktop Studio windows with a separate test plugin gated by
 * an unguessable RunScript launch token. The managed plugin remains untouched.
 * Settings persistence is isolated in the temporary model; App,
 * ServeSession, reconciliation and HTTP/WebSocket transport use the shipped
 * implementation. These direct-launch integration cases observe actual
 * in-Studio tree values; CLI launch/readiness orchestration is covered
 * separately.
 */
import process from "node:process";
import { describe, expect, it } from "vitest";

import { readVariable } from "../../src/process/environment.ts";
import { makeRealStudioSyncAsync } from "../helpers/real-studio-sync.ts";

const IS_ENABLED =
	process.platform === "win32" &&
	readVariable(process.env, "RBX_FORGE_TEST_REAL_STUDIO", process.platform) === "1";

describe.skipIf(!IS_ENABLED)("real Studio Rojo synchronization", () => {
	it(
		"should apply the marker's initial tree without confirmation",
		{ timeout: 240_000 },
		async () => {
			expect.assertions(4);

			const studio = await makeRealStudioSyncAsync(true);

			await expect(studio.waitForReadyAsync()).resolves.toBeTrue();

			const observed = await studio.waitForValueAsync("initial");
			studio.writeProbe("live-edit");
			const edited = await studio.waitForValueAsync("live-edit");

			expect(observed.name).toBe(studio.projectName);
			expect(edited.name).toBe(studio.projectName);
			expect(studio.isBlocked()).toBeFalse();
		},
	);

	it(
		"should preserve another Studio's independent connection through launch and cleanup",
		{ timeout: 240_000 },
		async () => {
			expect.assertions(5);

			const spectator = await makeRealStudioSyncAsync(true);
			const connected = await spectator.waitForValueAsync("initial");

			expect(connected.loadCount).toBe(1);

			const spectatorPin = spectator.studio;
			const cursor = spectator.sampleCursor();
			const owned = await makeRealStudioSyncAsync(true);
			await owned.waitForValueAsync("initial");
			owned.writeProbe("owned-edit");
			await owned.waitForValueAsync("owned-edit");
			await owned.cleanupAsync();
			await spectator.observeForAsync(3000);
			const observations = spectator.samplesSince(cursor);

			expect(spectatorPin.isAlive()).toBeTrue();
			expect(spectator.studio).toBe(spectatorPin);
			expect(observations.length).toBeGreaterThan(1);
			expect(observations.map(({ sequence: _sequence, ...sample }) => sample)).toStrictEqual(
				Array.from({ length: observations.length }, () => {
					return {
						name: spectator.projectName,
						connection: connected.connection,
						loadCount: connected.loadCount,
						value: "initial",
					};
				}),
			);
		},
	);

	it("should stay disconnected without a launch marker", { timeout: 240_000 }, async () => {
		expect.assertions(5);

		const studio = await makeRealStudioSyncAsync(false);
		const observations = await studio.observeForAsync(15_000);

		expect(observations.length).toBeGreaterThan(10);
		expect(observations.map(({ value }) => value)).toStrictEqual(
			Array.from({ length: observations.length }).fill(""),
		);
		expect(observations.map(({ name }) => name)).not.toContain(studio.projectName);
		expect(observations.every(({ connection }) => connection === "")).toBeTrue();
		expect(studio.isBlocked()).toBeFalse();
	});

	it(
		"should reconnect on the same port and apply edits made offline",
		{ timeout: 240_000 },
		async () => {
			expect.assertions(3);

			const studio = await makeRealStudioSyncAsync(true);
			await studio.waitForValueAsync("initial");
			const originalSession = studio.sessionId;
			await studio.stopRojoAsync();
			await studio.observeForAsync(3000);
			studio.writeProbe("edited-offline");
			await studio.restartRojoAsync();
			const observed = await studio.waitForValueAsync("edited-offline");

			expect(studio.sessionId).not.toBe(originalSession);
			expect(observed.name).toBe(studio.projectName);
			expect(studio.isBlocked()).toBeFalse();
		},
	);

	it(
		"should refuse another wrapper on the same port without applying its tree",
		{ timeout: 240_000 },
		async () => {
			expect.assertions(5);

			const studio = await makeRealStudioSyncAsync(true);
			await studio.waitForValueAsync("initial");
			await studio.stopRojoAsync();
			await studio.observeForAsync(3000);
			studio.writeProbe("foreign-tree");
			await studio.restartRojoAsync("another-worktree@foreign");
			const observations = await studio.observeForAsync(15_000);

			expect(observations.length).toBeGreaterThan(10);
			expect(observations.every(({ value }) => value === "initial")).toBeTrue();
			expect(observations.every(({ name }) => name === studio.projectName)).toBeTrue();
			expect(observations.every(({ connection }) => connection === "")).toBeTrue();
			expect(studio.isBlocked()).toBeFalse();
		},
	);
});
