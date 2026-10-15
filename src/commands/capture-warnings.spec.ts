import path from "node:path";
import { describe, it } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import { createJsonReporter, createTtyReporter } from "../output/reporters.ts";
import { runSaveAsync } from "./save.ts";

describe("capture warnings", () => {
	it("shows capture warnings to a person before reporting the original save failure", async ({
		expect,
	}) => {
		expect.assertions(2);

		const memory = createMemoryFileSystem();
		const ipc = createMemoryTransport();
		const session = await serveFakeSessionAsync(memory, ipc);
		session.save = () => {
			throw new ForgeError("capture_timeout", "Capture expired.", {
				details: {
					captureWarnings: [
						{
							property: "CollisionGroups",
							reason: "collision_groups",
							service: "Workspace",
						},
					],
				},
			});
		};

		const stderr: Array<string> = [];
		const context = createCommandContext({
			reporter: createTtyReporter({
				stderr: (line) => {
					stderr.push(line);
				},
				stdout: () => {},
			}),
			seams: createTestSeams({ fileSystem: memory.fileSystem, ipc }),
		});

		await expect(runSaveAsync(context, { config: {}, flags: {} })).rejects.toMatchObject({
			code: "capture_timeout",
			message: "Capture expired.",
		});
		expect(stderr).toStrictEqual([
			"warning: Workspace.CollisionGroups cannot be captured; set it in the project file.\n",
		]);
	});

	it("ignores malformed warning metadata without replacing a session failure", async ({
		expect,
	}) => {
		expect.assertions(2);

		const memory = createMemoryFileSystem();
		const ipc = createMemoryTransport();
		const session = await serveFakeSessionAsync(memory, ipc);
		session.save = () => {
			throw new ForgeError("save_failed", "Could not save.", {
				details: {
					captureWarnings: [
						{ property: "CollisionGroups", reason: "unknown", service: "Workspace" },
					],
				},
			});
		};

		const reporter = createRecordingReporter();
		const context = createCommandContext({
			reporter,
			seams: createTestSeams({ fileSystem: memory.fileSystem, ipc }),
		});

		await expect(runSaveAsync(context, { config: {}, flags: {} })).rejects.toMatchObject({
			code: "save_failed",
			message: "Could not save.",
		});
		expect(reporter.events).toStrictEqual([]);
	});

	it("emits received warnings when the session reports capture assembly failure", async ({
		expect,
	}) => {
		expect.assertions(2);

		const memory = createMemoryFileSystem();
		const ipc = createMemoryTransport();
		const session = await serveFakeSessionAsync(memory, ipc);
		const warning = {
			property: "StreamingTargetRadius",
			reason: "unreadable",
			service: "Workspace",
		};
		session.save = () => {
			throw new ForgeError(
				"capture_assembly_failed",
				"The captured place could not be assembled.",
				{
					details: { captureWarnings: [warning], message: "invalid model" },
					hint: "Try a fresh capture.",
				},
			);
		};

		const events: Array<unknown> = [];
		const context = createCommandContext({
			reporter: createJsonReporter({
				stderr: () => {},
				stdout: (line) => {
					events.push(JSON.parse(line));
				},
			}),
			seams: createTestSeams({ fileSystem: memory.fileSystem, ipc }),
		});

		await expect(runSaveAsync(context, { config: {}, flags: {} })).rejects.toMatchObject({
			code: "capture_assembly_failed",
			details: { captureWarnings: [warning], message: "invalid model" },
			hint: "Try a fresh capture.",
			message: "The captured place could not be assembled.",
		});
		expect(events).toStrictEqual([
			{
				...warning,
				message:
					"Workspace.StreamingTargetRadius cannot be captured; set it in the project file.",
				type: "warning",
			},
		]);
	});

	it("names an unreadable property in the result and its NDJSON warning event", async ({
		expect,
	}) => {
		expect.assertions(2);

		const memory = createMemoryFileSystem();
		const ipc = createMemoryTransport();
		const session = await serveFakeSessionAsync(memory, ipc);
		const warning = {
			property: "StreamingTargetRadius",
			reason: "unreadable",
			service: "Workspace",
		};
		session.save = () => {
			return {
				bytes: 10,
				desktop: "user",
				durationMs: 12,
				mtime: "2026-01-01T00:00:00.000Z",
				pid: 42,
				place: path.join(PROJECT, "game.rbxl"),
				warnings: [warning],
			};
		};

		const events: Array<unknown> = [];
		const context = createCommandContext({
			reporter: createJsonReporter({
				stderr: () => {},
				stdout: (line) => {
					events.push(JSON.parse(line));
				},
			}),
			seams: createTestSeams({ fileSystem: memory.fileSystem, ipc }),
		});

		const saved = await runSaveAsync(context, { config: {}, flags: {} });

		expect(saved.data["warnings"]).toStrictEqual([warning]);
		expect(events).toContainEqual({
			...warning,
			message:
				"Workspace.StreamingTargetRadius cannot be captured; set it in the project file.",
			type: "warning",
		});
	});
});
