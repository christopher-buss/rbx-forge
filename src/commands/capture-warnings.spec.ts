import path from "node:path";
import { describe, it } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import { createJsonReporter } from "../output/reporters.ts";
import { runSaveAsync } from "./save.ts";

describe("capture warnings", () => {
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
