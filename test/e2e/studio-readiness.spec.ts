import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { assert, describe, expect, it } from "vitest";

import type { SessionStatus } from "../../src/session/status.ts";
import { parseStatus } from "../../src/session/status.ts";
import { studioLockPath } from "../../src/studio/lock-file.ts";
import { waitForDeathAsync } from "../helpers/worker-log.ts";
import type { Fixture } from "./session-fixture.ts";
import { makeFixtureAsync, STUDIO_PROJECT, wrapperPath } from "./session-fixture.ts";
import { runForgeAsync, WATCH_COMMAND } from "./up-fixture.ts";

const UP = ["up", "--studio", "--json"];

async function managedFixtureAsync(config: Record<string, unknown>): Promise<Fixture> {
	const fixture = await makeFixtureAsync(config, { studio: true });
	const home = path.join(fixture.project, "home");
	const directory =
		process.platform === "win32"
			? path.join(home, "AppData", "Local", "Roblox", "Plugins")
			: path.join(home, "Documents", "Roblox", "Plugins");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		path.join(directory, "RojoManagedPlugin.rbxm"),
		gunzipSync(
			readFileSync(path.join(import.meta.dirname, "../fixtures/models/rojo-7.7.1.rbxm.gz")),
		),
	);
	return {
		...fixture,
		environment: (variables) => {
			return fixture.environment({
				...variables,
				HOME: home,
				LOCALAPPDATA: path.join(home, "AppData", "Local"),
				USERPROFILE: home,
			});
		},
	};
}

async function lockedStatusAsync(fixture: Fixture): Promise<SessionStatus> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const run = await runForgeAsync(fixture, ["status", "--json"]);
		const status = parseStatus(run.result.data);
		if (status !== undefined && existsSync(studioLockPath(fixture.place))) {
			return status;
		}

		assert(Date.now() < deadline, "Studio never locked the place");
		await sleep(50);
	}
}

function readyUrl(fixture: Fixture): string {
	const marker = readFileSync(
		path.join(path.dirname(wrapperPath(fixture)), "studio-marker.lua"),
		"utf8",
	);
	const matched = /m:SetAttribute\("ReadyUrl","([^"\n]+)"\)/u.exec(marker);
	assert(matched?.[1] !== undefined);
	return matched[1];
}

describe.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
	"cli managed Studio synchronization readiness",
	() => {
		it("should keep a locked place opening until its delayed acknowledgement arrives", async () => {
			expect.assertions(4);

			const fixture = await managedFixtureAsync({ ...STUDIO_PROJECT, ...WATCH_COMMAND });
			const opening = runForgeAsync(fixture, UP, { FIXTURE_STUDIO_ACK_DELAY_MS: "3000" });
			const locked = await lockedStatusAsync(fixture);

			expect(locked.services.studio.status).toBe("opening");

			const opened = await opening;

			expect(opened.result).toMatchObject({
				data: { services: { studio: { status: "open" } } },
				ok: true,
			});
			expect(opened.status).toBe(0);
			await expect(fetch(readyUrl(fixture))).rejects.toThrow("fetch failed");
		});

		it.for(["none", "wrong"])(
			"should stop a locked Studio while up waits for a %s acknowledgement",
			async (mode) => {
				expect.assertions(5);

				const fixture = await managedFixtureAsync({ ...STUDIO_PROJECT, ...WATCH_COMMAND });
				const opening = runForgeAsync(fixture, UP, { FIXTURE_STUDIO_ACK: mode });
				const locked = await lockedStatusAsync(fixture);
				assert(locked.services.studio.pid !== undefined);
				const url = readyUrl(fixture);

				expect(locked.services.studio.status).toBe("opening");

				const stopped = await runForgeAsync(fixture, ["stop", "--json"]);
				const failed = await opening;

				expect(stopped.result.ok).toBeTrue();
				expect(failed.result.error).toMatchObject({ code: "studio_launch_failed" });
				await expect(
					waitForDeathAsync([locked.services.studio.pid], 5000),
				).resolves.toStrictEqual([]);
				await expect(fetch(url)).rejects.toThrow("fetch failed");
			},
		);

		it.for(["stop", "down"])(
			"should %s a session without a compiler while up waits for acknowledgement",
			async (command) => {
				expect.assertions(4);

				const fixture = await managedFixtureAsync(STUDIO_PROJECT);
				const opening = runForgeAsync(fixture, [...UP, "--no-compiler"], {
					FIXTURE_STUDIO_ACK: "none",
				});
				const locked = await lockedStatusAsync(fixture);
				assert(locked.services.studio.pid !== undefined);
				const url = readyUrl(fixture);
				const stopped = await runForgeAsync(fixture, [command, "--json"]);
				const failed = await opening;

				expect(stopped.result.ok).toBeTrue();
				expect(failed.result.error).toMatchObject({ code: "studio_launch_failed" });
				await expect(
					waitForDeathAsync([locked.services.studio.pid], 5000),
				).resolves.toStrictEqual([]);
				await expect(fetch(url)).rejects.toThrow("fetch failed");
			},
		);
	},
);
