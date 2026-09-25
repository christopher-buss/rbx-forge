import { describe, expect, it } from "vitest";

import { rojoBuildArgs } from "./rojo.ts";

describe(rojoBuildArgs, () => {
	it("should build the project to an output file", () => {
		expect.assertions(1);

		expect(
			rojoBuildArgs("default.project.json", { output: "out/game.rbxl", type: "output" }),
		).toStrictEqual(["build", "default.project.json", "--output", "out/game.rbxl"]);
	});

	it("should build the project into the plugins folder", () => {
		expect.assertions(1);

		expect(
			rojoBuildArgs("plugin.project.json", { plugin: "Tool.rbxm", type: "plugin" }),
		).toStrictEqual(["build", "plugin.project.json", "--plugin", "Tool.rbxm"]);
	});
});
