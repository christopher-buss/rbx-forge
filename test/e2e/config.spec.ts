import path from "node:path";
import { describe, expect, it } from "vitest";

import { EXIT_FAILURE, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import { parseLines, parseResult } from "../helpers/output.ts";
import { makeProject, runBinAsync } from "./run-bin.ts";

const CONFIG_FILE = "rbx-forge.config.ts";

function configFile(body: string): Record<string, string> {
	return {
		[CONFIG_FILE]: `import { defineConfig } from "rbx-forge";\n\nexport default defineConfig(${body});\n`,
	};
}

describe("forge config", () => {
	it("should print the file's values over the defaults as NDJSON", async () => {
		expect.assertions(2);

		const project = makeProject(
			configFile(
				'{ projectType: "rbxts", rojoPort: 4000, typegen: { include: ["Workspace/**"] } }',
			),
		);
		const { status, stdout } = await runBinAsync(["config", "--json"], project);

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseLines(stdout)).toStrictEqual([
			{
				command: "config",
				data: {
					config: {
						buildOutputPath: "game.rbxl",
						gracefulTimeoutMs: 3000,
						hooks: {},
						hookTimeoutMs: 300_000,
						luau: { watch: { args: [] } },
						open: { buildFirst: true },
						projectType: "rbxts",
						rbxts: { args: [], command: "rbxtsc" },
						rojoAlias: "rojo",
						rojoPort: 4000,
						rojoProjectPath: "default.project.json",
						studio: { autoRecovery: "move" },
						syncback: { runOnStart: false },
						typegen: {
							exclude: ["**/node_modules/**"],
							include: ["Workspace/**"],
							outputPath: "src/services.d.ts",
						},
					},
					path: path.join(project, CONFIG_FILE).replaceAll("\\", "/"),
				},
				ok: true,
				type: "result",
			},
		]);
	});

	it("should exit 1 with config_invalid for an unknown key", async () => {
		expect.assertions(2);

		const project = makeProject(configFile('{ projectType: "rbxts", serve: true }'));
		const { status, stdout } = await runBinAsync(["config"], project);

		expect(status).toBe(EXIT_FAILURE);
		expect(parseLines(stdout)).toStrictEqual([
			{
				command: "config",
				error: {
					code: "config_invalid",
					hint: "Fix or remove the keys named above.",
					message: `Invalid config in ${path.join(project, CONFIG_FILE).replaceAll("\\", "/")}:\nserve must be removed`,
				},
				exitCode: EXIT_FAILURE,
				ok: false,
				type: "result",
			},
		]);
	});

	it("should exit 1 with config_not_found in a project without a config file", async () => {
		expect.assertions(2);

		const { status, stdout } = await runBinAsync(["config"], makeProject());

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout)).toMatchObject({ error: { code: "config_not_found" } });
	});
});
