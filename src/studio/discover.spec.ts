import path from "node:path";
import { describe, expect, it } from "vitest";

import { catchForgeError } from "../../test/helpers/errors.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import type { NativeAddon } from "../native/addon.ts";
import type { Environment } from "../seams/seams.ts";
import type { DiscoverySeams } from "./discover.ts";
import {
	commandExecutable,
	findStudioExecutable,
	MACOS_STUDIO_PATH,
	STUDIO_PATH_VARIABLE,
	STUDIO_REGISTRY_KEYS,
	withStudioPath,
} from "./discover.ts";

const FLAG_EXE = path.join(PROJECT, "flag", "RobloxStudioBeta.exe");
const ENV_EXE = path.join(PROJECT, "env", "RobloxStudioBeta.exe");
const LINK_EXE = path.join(PROJECT, "link", "RobloxStudioBeta.exe");
const PLACE_EXE = path.join(PROJECT, "place", "RobloxStudioBeta.exe");
const LINK_KEY = String.raw`Software\Classes\roblox-studio\shell\open\command`;
const PLACE_KEY = String.raw`Software\Classes\Roblox.Place\shell\open\command`;

interface Setup {
	/** Files that exist, by absolute path. */
	files?: ReadonlyArray<string>;
	/** Replaces the whole addon. */
	native?: () => NativeAddon;
	platform?: NodeJS.Platform;
	/** Registry default values by key; `null` fails the read. */
	registry?: Record<string, null | string>;
}

function seamsOf({
	files = [],
	native,
	platform = "win32",
	registry = {},
}: Setup = {}): DiscoverySeams {
	const memory = createMemoryFileSystem();
	for (const file of files) {
		memory.fileSystem.mkdirSync(path.dirname(file), { recursive: true });
		memory.fileSystem.writeFileSync(file, "");
	}

	const { addon } = createFakeNative({}, registry);
	return { fileSystem: memory.fileSystem, host: { platform }, native: native ?? (() => addon) };
}

function find(setup: Setup, environment: Environment = {}, studioPath?: string): unknown {
	return findStudioExecutable(seamsOf(setup), { env: environment, studioPath });
}

describe(findStudioExecutable, () => {
	it("should read the link handler, then the .rbxl file type", () => {
		expect.assertions(1);

		expect(STUDIO_REGISTRY_KEYS).toStrictEqual([LINK_KEY, PLACE_KEY]);
	});

	it("should take the flag first", () => {
		expect.assertions(1);

		expect(
			find(
				{
					files: [FLAG_EXE, ENV_EXE, LINK_EXE],
					registry: { [LINK_KEY]: `"${LINK_EXE}" %1` },
				},
				{ [STUDIO_PATH_VARIABLE]: ENV_EXE },
				FLAG_EXE,
			),
		).toStrictEqual({ path: FLAG_EXE, source: "flag" });
	});

	it("should take the variable over the registry, in any case on Windows", () => {
		expect.assertions(1);

		expect(
			find(
				{ files: [ENV_EXE, LINK_EXE], registry: { [LINK_KEY]: `"${LINK_EXE}" %1` } },
				{ rbx_forge_studio_path: ENV_EXE },
			),
		).toStrictEqual({ path: ENV_EXE, source: "environment" });
	});

	it("should treat an empty variable as unset", () => {
		expect.assertions(1);

		expect(
			find(
				{ files: [LINK_EXE], registry: { [LINK_KEY]: `"${LINK_EXE}" %1` } },
				{ [STUDIO_PATH_VARIABLE]: "" },
			),
		).toStrictEqual({ path: LINK_EXE, source: "registry" });
	});

	it("should fail when the flag or the variable names no file", () => {
		expect.assertions(2);

		expect(catchForgeError(() => find({}, {}, FLAG_EXE))).toMatchObject({
			code: "studio_launch_failed",
			hint: "Set --studio-path to the Roblox Studio executable, or leave it unset.",
		});
		expect(catchForgeError(() => find({}, { [STUDIO_PATH_VARIABLE]: ENV_EXE }))).toMatchObject({
			code: "studio_launch_failed",
			message: `${STUDIO_PATH_VARIABLE} names ${ENV_EXE}, which is not a file.`,
		});
	});

	it("should fall back to the .rbxl file type when the link handler is missing or gone", () => {
		expect.assertions(2);

		const registry = { [PLACE_KEY]: `"${PLACE_EXE}" "%1"` };

		expect(find({ files: [PLACE_EXE], registry })).toStrictEqual({
			path: PLACE_EXE,
			source: "registry",
		});
		expect(
			find({ files: [PLACE_EXE], registry: { ...registry, [LINK_KEY]: `"${LINK_EXE}" %1` } }),
		).toStrictEqual({ path: PLACE_EXE, source: "registry" });
	});

	it("should skip a registry value that fails to read or names no program", () => {
		expect.assertions(1);

		expect(
			find({
				files: [PLACE_EXE],
				registry: { [LINK_KEY]: null, [PLACE_KEY]: " ".repeat(3) },
			}),
		).toBeUndefined();
	});

	it("should find nothing without the addon or its registry read", () => {
		expect.assertions(2);

		expect(
			find({
				native: () => {
					throw new ForgeError("native_missing", "no addon");
				},
			}),
		).toBeUndefined();
		expect(find({ files: [LINK_EXE] })).toBeUndefined();
	});

	it("should find the installed app on macOS", () => {
		expect.assertions(2);

		expect(find({ files: [MACOS_STUDIO_PATH], platform: "darwin" })).toStrictEqual({
			path: MACOS_STUDIO_PATH,
			source: "application",
		});
		expect(find({ platform: "darwin" })).toBeUndefined();
	});

	it("should find nothing on Linux", () => {
		expect.assertions(1);

		expect(find({ files: [LINK_EXE, MACOS_STUDIO_PATH], platform: "linux" })).toBeUndefined();
	});
});

describe(commandExecutable, () => {
	it.for([
		[
			String.raw`"C:\Program Files\Roblox\RobloxStudioBeta.exe" %1`,
			String.raw`C:\Program Files\Roblox\RobloxStudioBeta.exe`,
		],
		[String.raw`  "C:\R\RobloxStudioBeta.exe" "%1"`, String.raw`C:\R\RobloxStudioBeta.exe`],
		[String.raw`C:\Roblox\RobloxStudioBeta.exe %1`, String.raw`C:\Roblox\RobloxStudioBeta.exe`],
		[String.raw`C:\Roblox\RobloxStudioBeta.EXE`, String.raw`C:\Roblox\RobloxStudioBeta.EXE`],
		[String.raw`C:\Roblox\Studio.exes %1`, undefined],
		["", undefined],
	] as const)("should read %j as %j", ([command, executable]) => {
		expect.assertions(1);

		expect(commandExecutable(command)).toBe(executable);
	});
});

describe(withStudioPath, () => {
	it("should put the resolved flag in the session's environment", () => {
		expect.assertions(2);

		expect(
			withStudioPath({ Rbx_Forge_Studio_Path: "old" }, PROJECT, "win32", {
				"studio-path": "bin/Studio.exe",
			}),
		).toStrictEqual({ Rbx_Forge_Studio_Path: path.resolve(PROJECT, "bin/Studio.exe") });
		expect(withStudioPath({ A: "1" }, PROJECT, "linux", {})).toStrictEqual({ A: "1" });
	});
});
