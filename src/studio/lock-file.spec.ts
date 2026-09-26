// cspell:ignore SAPPHIR VERYLONGCOMPUTE VERYLONGCOMPUT VERYLONGCOMPUTX
// cspell:ignore verylongcomputername STRASSE straße
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import {
	isLockHost,
	isStudioExecutable,
	parseStudioLock,
	readLockFile,
	studioLockPath,
} from "./lock-file.ts";

/** A lock file as Roblox Studio 0.700 on Windows writes it. */
const WINDOWS_LOCK = "47212\nRobloxStudioBeta\nSAPPHIRE\n4378769e-07d9-4eda-b5ee-187aa6c43cda\n\n";

describe(parseStudioLock, () => {
	it("should read the PID from the first line of a Studio lock file", () => {
		expect.assertions(1);

		expect(parseStudioLock(WINDOWS_LOCK)).toStrictEqual({ host: "SAPPHIRE", pid: 47_212 });
	});

	it("should read a lock file with CRLF line endings", () => {
		expect.assertions(1);

		expect(parseStudioLock("512\r\nRobloxStudio\r\nmac-mini\r\n")).toStrictEqual({
			host: "mac-mini",
			pid: 512,
		});
	});

	it("should read a lock file that holds only the PID", () => {
		expect.assertions(1);

		expect(parseStudioLock("7")).toStrictEqual({ host: undefined, pid: 7 });
	});

	it("should read the largest PID", () => {
		expect.assertions(1);

		expect(parseStudioLock("4294967295\n")).toStrictEqual({
			host: undefined,
			pid: 4_294_967_295,
		});
	});

	it.for(["1\nRobloxStudio\n\n", "1\nRobloxStudio\n  \n"])(
		"should find no host in %j",
		(text) => {
			expect.assertions(1);

			expect(parseStudioLock(text)).toStrictEqual({ host: undefined, pid: 1 });
		},
	);

	it("should trim the host", () => {
		expect.assertions(1);

		expect(parseStudioLock("1\nRobloxStudio\n SAPPHIRE \nguid")!.host).toBe("SAPPHIRE");
	});

	it.for([
		"",
		"\n47212\n",
		"4294967296\n",
		"abc\n",
		"12x\n",
		"-5\n",
		"0\n",
		"1.5\n",
		" 12\n",
		"99999999999\n",
	])("should find no PID in %j", (text) => {
		expect.assertions(1);

		expect(parseStudioLock(text)).toBeUndefined();
	});
});

describe(isStudioExecutable, () => {
	it.for([
		String.raw`C:\Users\me\AppData\Local\Roblox\Versions\version-1\RobloxStudioBeta.exe`,
		String.raw`C:\Roblox\robloxstudiobeta.EXE`,
		"/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio",
		"/tmp/fixture/RobloxStudioBeta",
		"RobloxStudio.exe",
	])("should accept %s", (executable) => {
		expect.assertions(1);

		expect(isStudioExecutable(executable)).toBeTrue();
	});

	it.for([
		String.raw`C:\Program Files\nodejs\node.exe`,
		"/usr/bin/sleep",
		String.raw`C:\RobloxStudioBeta.exe\node.exe`,
		"/opt/NotRobloxStudio",
		"/opt/RobloxStudioBeta.exe.bak",
		"/opt/RobloxStudioBeta_exe",
		"RobloxPlayerBeta.exe",
		"",
	])("should reject %s", (executable) => {
		expect.assertions(1);

		expect(isStudioExecutable(executable)).toBeFalse();
	});
});

describe(isLockHost, () => {
	it.for([
		["SAPPHIRE", "Sapphire"],
		["sapphire", "SAPPHIRE"],
		["Chris-Mac", "Chris-Mac.local"],
		["chris-mac.local", "Chris-Mac"],
		["DESKTOP-ABCDEFGH", "desktop-abcdefgh.corp.example.com"],
		// Windows NetBIOS names stop at 15 characters.
		["VERYLONGCOMPUTE", "verylongcomputername"],
	])("should accept lock host %s on host %s", ([lockHost, hostname]) => {
		expect.assertions(1);

		expect(isLockHost(lockHost!, hostname!)).toBeTrue();
	});

	it.for([
		["OTHER", "SAPPHIRE"],
		["SAPPHIRE2", "SAPPHIRE"],
		["SAPPHIR", "SAPPHIRE"],
		["local", "Chris-Mac.local"],
		["VERYLONGCOMPUT", "verylongcomputername"],
		["VERYLONGCOMPUTX", "verylongcomputername"],
		["", "SAPPHIRE"],
		// Names compare in lower case, where "ß" stays: it does not become "ss".
		["STRASSE", "straße"],
	])("should reject lock host %s on host %s", ([lockHost, hostname]) => {
		expect.assertions(1);

		expect(isLockHost(lockHost!, hostname!)).toBeFalse();
	});
});

describe(studioLockPath, () => {
	it("should put the lock file next to the place, named after it", () => {
		expect.assertions(1);

		expect(studioLockPath("/project/game.rbxl")).toBe("/project/game.rbxl.lock");
	});
});

describe(readLockFile, () => {
	const lockPath = path.join(PROJECT, "game.rbxl.lock");

	it("should read the lock file's content", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "game.rbxl.lock": "7" });

		expect(readLockFile(fileSystem, lockPath)).toBe("7");
	});

	it("should return undefined when there is no lock file", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(readLockFile(fileSystem, lockPath)).toBeUndefined();
	});

	it("should throw other read errors", () => {
		expect.assertions(1);

		const error = Object.assign(new Error("EACCES: denied"), { code: "EACCES" });
		const fileSystem = {
			readFileSync: () => {
				throw error;
			},
		};

		expect(() => readLockFile(fileSystem, lockPath)).toThrow(error);
	});
});
