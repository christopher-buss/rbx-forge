import { describe, it } from "vitest";

import { pathDelimiter, prependPath, readVariable, withVariables } from "./environment.ts";

describe(readVariable, () => {
	it("should ignore the case of a Windows name", ({ expect }) => {
		expect.assertions(1);

		expect(readVariable({ Path: "C:\\bin" }, "PATH", "win32")).toBe("C:\\bin");
	});

	it("should match POSIX names exactly", ({ expect }) => {
		expect.assertions(1);

		expect(readVariable({ Path: "/bin" }, "PATH", "linux")).toBeUndefined();
	});
});

describe(withVariables, () => {
	it("should replace a Windows variable whose name differs in case", ({ expect }) => {
		expect.assertions(1);

		expect(withVariables({ Path: "old", TEMP: "t" }, { PATH: "new" }, "win32")).toStrictEqual({
			Path: "new",
			TEMP: "t",
		});
	});

	it("should add a variable that is not set", ({ expect }) => {
		expect.assertions(1);

		expect(withVariables({ HOME: "/home" }, { PATH: "/bin" }, "win32")).toStrictEqual({
			HOME: "/home",
			PATH: "/bin",
		});
	});

	it("should leave the original environment unchanged", ({ expect }) => {
		expect.assertions(1);

		const environment = { PATH: "/bin" };
		withVariables(environment, { PATH: "/usr/bin" }, "linux");

		expect(environment).toStrictEqual({ PATH: "/bin" });
	});
});

describe(prependPath, () => {
	it.for([
		["linux", { PATH: "/usr/bin" }, { PATH: "/project/bin:/usr/bin" }],
		["win32", { Path: "C:\\bin" }, { Path: "/project/bin;C:\\bin" }],
		["linux", {}, { PATH: "/project/bin" }],
		["linux", { PATH: "" }, { PATH: "/project/bin" }],
	] as const)(
		"should put the directory first on %s %o",
		([platform, environment, expected], { expect }) => {
			expect.assertions(1);

			expect(prependPath(environment, "/project/bin", platform)).toStrictEqual(expected);
		},
	);
});

describe(pathDelimiter, () => {
	it.for([
		["win32", ";"],
		["darwin", ":"],
	] as const)("should separate %s entries with %s", ([platform, delimiter], { expect }) => {
		expect.assertions(1);

		expect(pathDelimiter(platform)).toBe(delimiter);
	});
});
