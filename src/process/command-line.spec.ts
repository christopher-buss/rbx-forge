import { describe, expect, it } from "vitest";

import { batchInvocation, shellInvocation } from "./command-line.ts";

describe(shellInvocation, () => {
	it("should run a POSIX command line through /bin/sh", () => {
		expect.assertions(1);

		expect(shellInvocation("eslint --fix .", "linux", {})).toStrictEqual({
			args: ["-c", "eslint --fix ."],
			file: "/bin/sh",
		});
	});

	it("should run a Windows command line through ComSpec, unquoted", () => {
		expect.assertions(1);

		expect(
			shellInvocation('eslint --fix "a b"', "win32", { COMSPEC: "C:\\cmd.exe" }),
		).toStrictEqual({
			args: ["/d", "/s", "/c", '"eslint --fix "a b""'],
			file: "C:\\cmd.exe",
			verbatimArguments: true,
		});
	});

	it("should fall back to cmd.exe without ComSpec", () => {
		expect.assertions(1);

		expect(shellInvocation("lint", "win32", {}).file).toBe("cmd.exe");
	});
});

describe(batchInvocation, () => {
	it("should escape the file and quote each argument for a shim", () => {
		expect.assertions(1);

		expect(
			batchInvocation("C:\\my tools\\rojo.cmd", ["build", "--output", "a b.rbxl"], {
				ComSpec: "C:\\Windows\\cmd.exe",
			}),
		).toStrictEqual({
			args: [
				"/d",
				"/s",
				"/c",
				'"C:\\my^ tools\\rojo.cmd ^^^"build^^^" ^^^"--output^^^" ^^^"a^^^ b.rbxl^^^""',
			],
			file: "C:\\Windows\\cmd.exe",
			verbatimArguments: true,
		});
	});

	it.for([
		['say "hi"', String.raw`^^^"say^^^ \^^^"hi\^^^"^^^"`],
		[String.raw`dir\ `, String.raw`^^^"dir\^^^ ^^^"`],
		[String.raw`C:\out\\`, String.raw`^^^"C:\out\\\\^^^"`],
		[String.raw`a\"b`, String.raw`^^^"a\\\^^^"b^^^"`],
		["100% & more", String.raw`^^^"100^^^%^^^ ^^^&^^^ more^^^"`],
	] as const)("should escape %s as %s", ([argument, escaped]) => {
		expect.assertions(1);

		expect(batchInvocation("x.cmd", [argument], {}).args[3]).toBe(`"x.cmd ${escaped}"`);
	});
});
