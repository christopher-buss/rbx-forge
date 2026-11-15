import path from "node:path";
import { describe, it } from "vitest";

import type { FakeProcess } from "../../test/helpers/native.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { createFakeStudioHost } from "../../test/helpers/studio-host.ts";
import { ForgeError } from "../errors.ts";
import type { NativeLoader } from "../native/addon.ts";
import type { StudioSeams } from "./close-studio.ts";
import { findPlaceStudioAsync } from "./close-studio.ts";

const PLACE = path.join(PROJECT, "game.rbxl");
const STUDIO: FakeProcess = { alive: true, executablePath: "/opt/RobloxStudio", startTime: "0" };

function seamsWith(lock: string, native: NativeLoader): StudioSeams {
	const seams = createTestSeams({ native });
	return {
		...seams,
		fileSystem: createMemoryFileSystem({ "game.rbxl.lock": lock }).fileSystem,
	};
}

describe(findPlaceStudioAsync, () => {
	it.for(["user", "hidden"] as const)(
		"should return the verified Studio on the %s desktop",
		async (desktop, { expect }) => {
			expect.assertions(1);

			const native = createFakeNative({ 7: { ...STUDIO, desktop } });
			const seams = seamsWith(`7\nRobloxStudio\n${TEST_HOSTNAME}\n`, () => native.addon);

			expect(await findPlaceStudioAsync(seams, PLACE)).toStrictEqual({
				desktop,
				pid: 7,
				startTime: "0",
			});
		},
	);

	it("reports hidden session visibility independently of its physical desktop", async ({
		expect,
	}) => {
		expect.assertions(1);

		const native = createFakeNative({
			7: { ...STUDIO, desktop: "user", windowVisibility: "hidden" },
		});

		expect(
			await findPlaceStudioAsync(
				seamsWith(`7\nRobloxStudio\n${TEST_HOSTNAME}\n`, () => native.addon),
				PLACE,
			),
		).toStrictEqual({ desktop: "hidden", pid: 7, startTime: "0" });
	});

	it("keeps a snapshot on its hidden physical desktop even when its windows are shown there", async ({
		expect,
	}) => {
		expect.assertions(1);

		const native = createFakeNative({
			7: { ...STUDIO, desktop: "hidden", windowVisibility: "user" },
		});

		expect(
			await findPlaceStudioAsync(
				seamsWith(`7\nRobloxStudio\n${TEST_HOSTNAME}\n`, () => native.addon),
				PLACE,
			),
		).toStrictEqual({ desktop: "hidden", pid: 7, startTime: "0" });
	});

	it("verifies Windows Studio start times and hostname while forge runs on Linux", async ({
		expect,
	}) => {
		expect.assertions(1);

		const memory = createMemoryFileSystem({
			"game.rbxl.lock": "7\nRobloxStudioBeta\nwindows-pc\n",
		});
		memory.setModifiedTime("game.rbxl.lock", 1767225600000);
		const seams = createTestSeams({ fileSystem: memory.fileSystem });
		const studio = createFakeStudioHost(
			{ ...seams, host: { ...seams.host, hostname: "windows-pc", platform: "win32" } },
			{
				7: {
					alive: true,
					executablePath: path.join(PROJECT, "RobloxStudioBeta.exe"),
					startTime: "134116992000000000",
				},
			},
		);
		seams.studioHost = studio.studioHost;

		expect(await findPlaceStudioAsync(seams, PLACE)).toStrictEqual({
			desktop: "user",
			pid: 7,
			startTime: "134116992000000000",
		});
	});

	it("should return undefined when the lock file names another computer", async ({ expect }) => {
		expect.assertions(1);

		const native = createFakeNative({ 7: STUDIO });
		const seams = seamsWith("7\nRobloxStudio\nelsewhere\n", () => native.addon);

		expect(await findPlaceStudioAsync(seams, PLACE)).toBeUndefined();
	});

	it("should throw native_missing when the addon is missing", async ({ expect }) => {
		expect.assertions(1);

		const missing = new ForgeError("native_missing", "no addon");
		const seams = seamsWith(`7\nRobloxStudio\n${TEST_HOSTNAME}\n`, () => {
			throw missing;
		});

		await expect(findPlaceStudioAsync(seams, PLACE)).rejects.toThrow(missing);
	});
});
