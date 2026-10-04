import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { createStudioMover } from "./studio-move.ts";
import type { StudioSetup } from "./studio-part.ts";

describe("move after saving", () => {
	it.for(["closed", "reused"])(
		"should reject a %s Studio identity after the save",
		async (change) => {
			expect.assertions(1);

			let now = 0;
			const memory = createMemoryFileSystem({
				"game.rbxl": "edits",
				"game.rbxl.lock": `777\nRobloxStudio\n${TEST_HOSTNAME}\n`,
			});
			const native = createFakeNative({
				777: {
					alive: true,
					desktop: "hidden",
					executablePath: "/opt/RobloxStudio",
					onSave: () => {
						memory.setModifiedTime("game.rbxl", 1);
					},
					startTime: "0",
				},
			});
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
			const setup: StudioSetup = fromAny({
				context,
				idle: {
					activity: vi
						.fn<StudioSetup["idle"]["activity"]>(() => {
							const process = native.processes.get(777)!;
							process.alive = change !== "closed";
							process.startTime = "99";
						})
						.mockImplementationOnce(() => {}),
				},
				status: {
					snapshot: () => {
						return {
							phase: "ready",
							services: {
								studio: {
									pid: 777,
									place: "game.rbxl",
									startTime: "0",
									status: "open",
								},
							},
						};
					},
				},
			});
			const abort = new AbortController();
			const move = createStudioMover(setup, fromAny({ signal: abort.signal }), fromAny({}));

			await expect(move({ desktop: "user", timeoutMs: 30_000 })).rejects.toMatchObject({
				code: "studio_not_open",
			});
		},
	);
});
