import path from "node:path";
import { describe, expect, it } from "vitest";

import { catchForgeError } from "../../test/helpers/errors.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { CommandContext } from "../commands/context.ts";
import { rojoBuildArgs, rojoInvocation, rojoServeArgs } from "./rojo.ts";

const TOOLS = path.join(PROJECT, "tools");

function contextWith(files: Record<string, string>): CommandContext {
	return createCommandContext({
		env: { PATH: TOOLS },
		seams: createTestSeams({ fileSystem: createMemoryFileSystem(files).fileSystem }),
	});
}

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

describe(rojoServeArgs, () => {
	it("should serve the project on the given port", () => {
		expect.assertions(1);

		expect(rojoServeArgs("default.project.json", 34_872)).toStrictEqual([
			"serve",
			"default.project.json",
			"--port",
			"34872",
		]);
	});
});

describe(rojoInvocation, () => {
	it("should start the configured Rojo command found on PATH", () => {
		expect.assertions(1);

		const context = contextWith({ "tools/rojo-fork": "" });

		expect(
			rojoInvocation(context, { rojoAlias: "rojo-fork" }, ["serve", "default.project.json"]),
		).toStrictEqual({
			args: ["serve", "default.project.json"],
			file: path.join(TOOLS, "rojo-fork"),
		});
	});

	it("should fail with rojo_missing when the command is not installed", () => {
		expect.assertions(2);

		const error = catchForgeError(() => {
			rojoInvocation(contextWith({}), { rojoAlias: "rojo" }, ["serve"]);
		});

		expect(error.code).toBe("rojo_missing");
		expect(error.hint).toBe(
			"Install Rojo (https://rojo.space), for example with rokit or mise, or set rojoAlias to its command.",
		);
	});
});
