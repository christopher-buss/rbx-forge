import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { EXIT_NEEDS_CONFIRMATION, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import { parseLines, parseResult } from "../helpers/output.ts";
import { makeProject, runBinAsync } from "./run-bin.ts";

describe("forge init", () => {
	it("should write a typed config file and nothing else", async () => {
		expect.assertions(3);

		const project = makeProject({ "package.json": "{}" });
		const { status } = await runBinAsync(["init", "--type", "luau"], project);

		expect(status).toBe(EXIT_SUCCESS);
		expect(readdirSync(project).toSorted()).toStrictEqual([
			"node_modules",
			"package.json",
			"rbx-forge.config.ts",
		]);
		expect(readFileSync(path.join(project, "rbx-forge.config.ts"), "utf8")).toBe(
			'import { defineConfig } from "rbx-forge";\n\nexport default defineConfig({\n\tprojectType: "luau",\n});\n',
		);
	});

	it("should write NDJSON events and a final result when it takes the default", async () => {
		expect.assertions(2);

		const project = makeProject();
		const { status, stdout } = await runBinAsync(["init", "--json"], project);

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseLines(stdout)).toStrictEqual([
			{ message: "No --type given; using rbxts.", type: "info" },
			{
				command: "init",
				data: {
					path: path.join(project, "rbx-forge.config.ts"),
					projectType: "rbxts",
					replaced: false,
				},
				ok: true,
				type: "result",
			},
		]);
	});

	it("should exit 4 without a prompt when a config file exists", async () => {
		expect.assertions(3);

		const project = makeProject({ "rbx-forge.config.ts": "old" });
		const { status, stdout } = await runBinAsync(["init", "--type", "rbxts"], project);

		expect(status).toBe(EXIT_NEEDS_CONFIRMATION);
		expect(parseLines(stdout)).toStrictEqual([
			{
				command: "init",
				error: {
					code: "needs_confirmation",
					hint: "Pass --force to replace it.",
					message: "rbx-forge.config.ts already exists.",
				},
				exitCode: EXIT_NEEDS_CONFIRMATION,
				ok: false,
				type: "result",
			},
		]);
		expect(readFileSync(path.join(project, "rbx-forge.config.ts"), "utf8")).toBe("old");
	});

	it("should write a config that forge loads", async () => {
		expect.assertions(2);

		const project = makeProject();
		await runBinAsync(["init", "--type", "luau"], project);
		const { status, stdout } = await runBinAsync(["config"], project);

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseResult(stdout).data!["config"]).toMatchObject({
			buildOutputPath: "game.rbxl",
			projectType: "luau",
		});
	});
});
