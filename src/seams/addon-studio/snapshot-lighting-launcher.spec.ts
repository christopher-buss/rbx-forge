import { assert, describe, it } from "vitest";

import { createFailingSpawner, createFakeSpawner } from "../../../test/helpers/fake-process.ts";
import { createTestSeams } from "../../../test/helpers/seams.ts";
import { createSnapshotLightingLauncher } from "./snapshot-lighting-launcher.ts";

const TARGET = {
	cwd: "D:/temp/agents/309",
	env: { OMIT: undefined, WSL_DISTRO_NAME: "fixture" },
	place: "/project/snapshot.rbxl",
	studio: { pid: 707, startTime: "windows-time" },
};

describe("linux snapshot watcher launch", () => {
	it("starts Linux snapshot watchers detached from the opening CLI", ({ expect }) => {
		expect.assertions(3);

		const spawner = createFakeSpawner();
		const seams = createTestSeams({ childProcess: spawner.runner });
		const launch = createSnapshotLightingLauncher(
			{
				...seams,
				host: { ...seams.host, platform: "linux" },
				native: () => {
					throw new Error("Linux must not use native Windows spawn");
				},
			},
			"/forge/supervisor.mjs",
		);

		expect(launch(TARGET)).toBe(1000);
		expect(spawner.calls).toEqual([
			{
				args: [
					"/forge/supervisor.mjs",
					"--watch-hidden-lighting",
					JSON.stringify({
						pid: 707,
						place: "/project/snapshot.rbxl",
						startTime: "windows-time",
					}),
				],
				file: seams.host.execPath,
				options: {
					cwd: TARGET.cwd,
					detached: true,
					env: { WSL_DISTRO_NAME: "fixture" },
					stdio: "ignore",
					windowsHide: true,
				},
			},
		]);

		const child = spawner.children[0];
		assert(child !== undefined);
		child.error(new Error("late spawn failure"));

		expect(child.referenced).toBeFalse();
	});

	it("reports a Linux watcher spawn failure", ({ expect }) => {
		expect.assertions(1);

		const seams = createTestSeams({ childProcess: createFailingSpawner("ENOENT") });
		const launch = createSnapshotLightingLauncher(
			{ ...seams, host: { ...seams.host, platform: "linux" } },
			"/forge/supervisor.mjs",
		);

		expect(() => launch(TARGET)).toThrow(
			"The hidden snapshot Lighting watcher could not start.",
		);
	});
});
