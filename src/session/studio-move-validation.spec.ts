import { fromPartial } from "@total-typescript/shoehorn";

import path from "node:path";
import { assert, describe, expect, it } from "vitest";

import { makeStatus } from "../../test/helpers/fake-session.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { createIdleTracker } from "./idle.ts";
import { createStudioMover } from "./studio-move.ts";

function savedStudio({
	abortOnLetGo = false,
	hasOrigin = true,
	hasRecordedStart = true,
	slowLookup = false,
} = {}) {
	const place = path.join(PROJECT, "game.rbxl");
	const memory = createMemoryFileSystem({
		"game.rbxl": "edits",
		"game.rbxl.lock": `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
	});
	memory.setModifiedTime("game.rbxl", 1000);
	const native = createFakeNative({
		42: {
			alive: true,
			desktop: "user",
			executablePath: "/opt/RobloxStudio",
			onSave: () => {
				memory.setModifiedTime("game.rbxl", 2000);
			},
		},
	});
	let now = 5000;
	let hasFinishedSave = false;
	const idle = createIdleTracker(1, 0);
	const pin = native.addon.pinProcess;

	native.addon.pinProcess = (pid) => {
		const pinned = pin(pid);
		assert(pinned !== null);
		return {
			...pinned,
			desktop: () => {
				if (slowLookup && hasFinishedSave) {
					hasFinishedSave = false;
					now += 1000;
				}

				return pinned.desktop();
			},
		};
	};

	const context = createCommandContext({
		seams: createTestSeams({
			clock: {
				now: () => now,
				sleep: async (ms) => {
					now += ms;
				},
			},
			fileSystem: memory.fileSystem,
			native: () => native.addon,
		}),
	});
	context.seams.host.platform = "win32";
	const status = makeStatus();
	status.services.studio = {
		desktop: "user",
		...(hasOrigin ? { origin: "found" as const } : {}),
		owner: null,
		pid: 42,
		place,
		...(hasRecordedStart ? { startTime: "42" } : {}),
		status: "open",
	};
	const lifetime = new AbortController();
	const move = createStudioMover(
		fromPartial({
			context,
			idle: {
				activity: (at: number) => {
					idle.activity(at);
					hasFinishedSave = at > 5000;
				},
			},
			status: fromPartial({ snapshot: () => status }),
		}),
		fromPartial({ signal: lifetime.signal }),
		fromPartial({
			state: {
				isAttached: true,
				letGo: () => {
					if (abortOnLetGo) {
						lifetime.abort();
					}
				},
			},
		}),
	);
	return { idle, move, native };
}

describe("move lifecycle validation", () => {
	it("keeps the saved Studio alive if the session ends while its old follow is released", async () => {
		expect.assertions(2);

		const { move, native } = savedStudio({ abortOnLetGo: true });

		await expect(move({ desktop: "hidden", timeoutMs: 30_000 })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(native.processes.get(42)).toMatchObject({ alive: true });
	});

	it("explains a corrupt open session without a Studio origin before closing it", async () => {
		expect.assertions(2);

		const { move, native } = savedStudio({ hasOrigin: false });

		await expect(move({ desktop: "hidden", timeoutMs: 30_000 })).rejects.toMatchObject({
			message: "An open session Studio has an origin.",
		});
		expect(native.processes.get(42)).toMatchObject({ alive: true });
	});

	it("includes post-save identity work in duration and refreshes activity after it finishes", async () => {
		expect.assertions(2);

		const { idle, move } = savedStudio({ slowLookup: true });

		await expect(move({ desktop: "user", timeoutMs: 30_000 })).resolves.toMatchObject({
			durationMs: 1300,
			from: "user",
			pid: 42,
			to: "user",
		});
		expect(idle.idleAt()).toBe(66_300);
	});

	it("can retain a verified place Studio without a recorded start time", async () => {
		expect.assertions(1);

		const { move } = savedStudio({ hasRecordedStart: false });

		await expect(move({ desktop: "user", timeoutMs: 30_000 })).resolves.toMatchObject({
			from: "user",
			pid: 42,
			to: "user",
		});
	});
});
