import path from "node:path";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import { createManualClock } from "../../test/helpers/manual-clock.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { createStudioLauncher } from "../studio/launcher.ts";
import { runSnapshotLightingAsync } from "../studio/snapshot-lighting.ts";
import { runOpenAsync } from "./open.ts";

function hiddenSnapshot({
	desktop = "hidden",
	watcherFails = false,
}: { desktop?: "hidden" | "user"; watcherFails?: boolean } = {}) {
	const clock = createManualClock(0);
	const memory = createMemoryFileSystem({ "RobloxStudioBeta.exe": "", "tools/rojo.exe": "" });
	const native = createFakeNative({
		42: { alive: true, desktop, executablePath: "RobloxStudioBeta.exe", startTime: "42" },
	});
	let watcher: Promise<void> | undefined;
	const studio = native.processes.get(42);
	assert(studio !== undefined);
	const seams = createTestSeams({
		clock: clock.clock,
		configLoader: async () => {
			return {
				path: path.join(PROJECT, "rbx-forge.config.json"),
				value: { projectType: "luau", studio: { desktop } },
			};
		},
		fileSystem: memory.fileSystem,
		host: { ...createTestSeams().host, platform: "win32" },
		native: () => native.addon,
		processRunner: async (spec) => {
			const output = spec.args[3];
			assert(output !== undefined);
			memory.fileSystem.mkdirSync(path.dirname(path.resolve(PROJECT, output)), {
				recursive: true,
			});
			memory.fileSystem.writeFileSync(path.resolve(PROJECT, output), "place");
			return { durationMs: 0, exitCode: 0, outputTail: [], signal: null, type: "exited" };
		},
	});
	native.addon.spawnDetached = (spawn) => {
		if (spawn.program === seams.host.execPath) {
			if (watcherFails) {
				throw new Error("job denies breakaway");
			}

			const payload = spawn.args[2];
			assert(payload !== undefined);
			watcher = runSnapshotLightingAsync(seams, payload);
			return 1000;
		}

		const place = spawn.args[0];
		assert(place !== undefined);
		memory.fileSystem.writeFileSync(`${place}.lock`, `42\nRobloxStudio\n${TEST_HOSTNAME}\n`);
		return 42;
	};

	seams.studioLauncher = createStudioLauncher(seams, "/forge/supervisor.mjs");
	onTestFinished(async () => {
		studio.alive = false;
		clock.advance(500);
		await watcher;
	});
	const reporter = createRecordingReporter();
	const context = createCommandContext({
		env: {
			PATH: path.join(PROJECT, "tools"),
			RBX_FORGE_STUDIO_PATH: path.join(PROJECT, "RobloxStudioBeta.exe"),
		},
		reporter,
		seams,
	});
	return { clock, context, reporter, studio, watcher: (): Promise<void> | undefined => watcher };
}

describe("hidden snapshot automatic Lighting", () => {
	it("returns the opened snapshot before watching its delayed migration prompt", async () => {
		expect.assertions(3);

		const run = hiddenSnapshot();

		await expect(runOpenAsync(run.context, { config: {}, flags: {} })).resolves.toMatchObject({
			data: { desktop: "hidden", studio: { pid: 42 } },
		});
		expect(run.clock.clock.now()).toBe(0);

		run.clock.advance(7000);
		run.studio.blocked = true;
		run.studio.dialog = { button: "Continue", title: "Lighting Technology Migration" };
		await run.watcher();

		expect(run.studio).toMatchObject({ alive: true, blocked: false });
	});

	it("returns the opened hidden snapshot with a warning when its helper cannot start", async () => {
		expect.assertions(2);

		const run = hiddenSnapshot({ watcherFails: true });

		await expect(runOpenAsync(run.context, { config: {}, flags: {} })).resolves.toMatchObject({
			data: { desktop: "hidden", studio: { pid: 42 } },
		});
		expect(run.reporter.events).toContainEqual({
			message:
				"Studio opened, but its automatic Lighting prompt watcher could not start: Error: job denies breakaway",
			type: "warning",
		});
	});

	it("leaves user-desktop prompts to the user", async () => {
		expect.assertions(2);

		const run = hiddenSnapshot({ desktop: "user", watcherFails: true });

		await expect(runOpenAsync(run.context, { config: {}, flags: {} })).resolves.toMatchObject({
			data: { desktop: "user" },
		});
		expect(run.reporter.events).not.toContainEqual(
			expect.objectContaining({ type: "warning" }),
		);
	});
});
