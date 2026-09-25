import { describe, expect, it } from "vitest";

import { isStudioExecutable, parseStudioLock, studioLockPath } from "./lock-file.ts";

/** A lock file as Roblox Studio 0.700 on Windows writes it. */
const WINDOWS_LOCK = "47212\nRobloxStudioBeta\nSAPPHIRE\n4378769e-07d9-4eda-b5ee-187aa6c43cda\n\n";

describe(parseStudioLock, () => {
	it("should read the PID from the first line of a Studio lock file", () => {
		expect.assertions(1);

		expect(parseStudioLock(WINDOWS_LOCK)).toStrictEqual({ pid: 47_212 });
	});

	it("should read a lock file with CRLF line endings", () => {
		expect.assertions(1);

		expect(parseStudioLock("512\r\nRobloxStudio\r\n")).toStrictEqual({ pid: 512 });
	});

	it("should read a lock file that holds only the PID", () => {
		expect.assertions(1);

		expect(parseStudioLock("7")).toStrictEqual({ pid: 7 });
	});

	it("should read the largest PID", () => {
		expect.assertions(1);

		expect(parseStudioLock("4294967295\n")).toStrictEqual({ pid: 4_294_967_295 });
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

describe(studioLockPath, () => {
	it("should put the lock file next to the place, named after it", () => {
		expect.assertions(1);

		expect(studioLockPath("/project/game.rbxl")).toBe("/project/game.rbxl.lock");
	});
});
