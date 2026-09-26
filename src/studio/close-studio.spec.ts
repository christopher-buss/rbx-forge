import path from "node:path";
import { describe, expect, it } from "vitest";

import type { FakeProcess } from "../../test/helpers/native.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import type { NativeLoader } from "../native/addon.ts";
import type { StudioSeams } from "./close-studio.ts";
import { findPlaceStudio } from "./close-studio.ts";

const PLACE = path.join(PROJECT, "game.rbxl");
const STUDIO: FakeProcess = { alive: true, executablePath: "/opt/RobloxStudio", startTime: "0" };

function seamsWith(lock: string, native: NativeLoader): StudioSeams {
	const seams = createTestSeams();
	return {
		...seams,
		fileSystem: createMemoryFileSystem({ "game.rbxl.lock": lock }).fileSystem,
		native,
	};
}

describe(findPlaceStudio, () => {
	it("should return the verified Studio the lock file names", () => {
		expect.assertions(1);

		const native = createFakeNative({ 7: STUDIO });
		const seams = seamsWith(`7\nRobloxStudio\n${TEST_HOSTNAME}\n`, () => native.addon);

		expect(findPlaceStudio(seams, PLACE)).toStrictEqual({ pid: 7, startTime: "0" });
	});

	it("should return undefined when the lock file names another computer", () => {
		expect.assertions(1);

		const native = createFakeNative({ 7: STUDIO });
		const seams = seamsWith("7\nRobloxStudio\nelsewhere\n", () => native.addon);

		expect(findPlaceStudio(seams, PLACE)).toBeUndefined();
	});

	it("should throw native_missing when the addon is missing", () => {
		expect.assertions(1);

		const missing = new ForgeError("native_missing", "no addon");
		const seams = seamsWith(`7\nRobloxStudio\n${TEST_HOSTNAME}\n`, () => {
			throw missing;
		});

		expect(() => findPlaceStudio(seams, PLACE)).toThrow(missing);
	});
});
