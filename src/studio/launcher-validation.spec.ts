import path from "node:path";
import { describe, expect, it } from "vitest";

import { createFakeSpawner } from "../../test/helpers/fake-process.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import { createMemoryFileSystem, createTestSeams, PROJECT } from "../../test/helpers/seams.ts";
import { createStudioLauncher } from "./launcher.ts";

describe("studio desktop reporting", () => {
	it("reports a direct Linux launch on the user desktop when hidden desktops are unavailable", async () => {
		expect.assertions(1);

		const studioPath = path.join(PROJECT, "Studio");
		const memory = createMemoryFileSystem({ Studio: "" });
		const native = createFakeNative({ 1000: { alive: true, executablePath: studioPath } });
		const seams = createTestSeams({
			childProcess: createFakeSpawner().runner,
			fileSystem: memory.fileSystem,
			native: () => native.addon,
		});
		const launch = createStudioLauncher(seams);

		await expect(
			launch({
				cwd: PROJECT,
				desktop: "hidden",
				env: {},
				place: path.join(PROJECT, "game.rbxl"),
				studioPath,
			}),
		).resolves.toMatchObject({
			studio: { desktop: "user", pid: 1000 },
			type: "launched",
		});
	});
});
