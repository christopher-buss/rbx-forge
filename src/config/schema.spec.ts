import { describe, expect, it } from "vitest";

import { catchForgeError } from "../../test/helpers/errors.ts";
import { ForgeError } from "../errors.ts";
import type { ForgeConfig } from "./schema.ts";
import { validateConfigFile, validateConfigLayer } from "./schema.ts";

const FILE = "/project/rbx-forge.config.ts";

// Every option the spec lists, set to a valid non-default value.
const FULL_CONFIG: ForgeConfig = {
	buildOutputPath: "place.rbxl",
	gracefulTimeoutMs: 5000,
	hooks: {
		build: { post: ["echo built"], pre: ["echo building"] },
		compile: { pre: ["codegen"] },
		open: { post: ["echo opened"] },
		syncback: { post: ["isentinel-lint --fix"] },
		typegen: { post: ["prettier --write src/services.d.ts"] },
	},
	luau: { watch: { args: ["process", "--watch"], command: "darklua" } },
	open: { buildFirst: false, buildOutputPath: "open.rbxl", projectPath: "open.project.json" },
	projectType: "luau",
	rbxts: { args: ["--verbose"], command: "rbxtsc" },
	rojoAlias: "rojo-fork",
	rojoPort: 34_873,
	rojoProjectPath: "build.project.json",
	syncback: { inputPath: "sync.rbxl", projectPath: "sync.project.json", runOnStart: true },
	typegen: {
		exclude: ["**/node_modules/**"],
		include: ["Workspace/**"],
		maxDepth: 4,
		outputPath: "src/services.d.ts",
	},
};

const errorOf = catchForgeError;

describe(validateConfigFile, () => {
	it("should accept every option", () => {
		expect.assertions(1);

		expect(validateConfigFile(FULL_CONFIG, FILE)).toStrictEqual(FULL_CONFIG);
	});

	it("should accept a config that sets only the project type", () => {
		expect.assertions(1);

		expect(validateConfigFile({ projectType: "rbxts" }, FILE)).toStrictEqual({
			projectType: "rbxts",
		});
	});

	it("should require the project type", () => {
		expect.assertions(2);

		const error = errorOf(() => validateConfigFile({}, FILE));

		expect(error.code).toBe("config_invalid");
		expect(error.message).toBe(
			`Invalid config in ${FILE}:\nprojectType must be "luau" or "rbxts" (was missing)`,
		);
	});

	it("should list every problem, one per line", () => {
		expect.assertions(1);

		const error = errorOf(() => validateConfigFile({ a: 1, projectType: "rbxts", z: 2 }, FILE));

		expect(error.message).toBe(
			`Invalid config in ${FILE}:\na must be removed\nz must be removed`,
		);
	});

	it.for([
		[{ projectType: "rbxts", unknownKey: 1 }, "unknownKey must be removed"],
		[{ projectType: "rbxts", typegen: { depth: 2 } }, "typegen.depth must be removed"],
		[{ hooks: { serve: { pre: [] } }, projectType: "rbxts" }, "hooks.serve must be removed"],
		[
			{ hooks: { build: { during: [] } }, projectType: "rbxts" },
			"hooks.build.during must be removed",
		],
	] as const)("should reject the unknown key in %o", ([value, problem]) => {
		expect.assertions(2);

		const error = errorOf(() => validateConfigFile(value, FILE));

		expect(error.code).toBe("config_invalid");
		expect(error.message).toBe(`Invalid config in ${FILE}:\n${problem}`);
	});

	it.for([
		[{ projectType: "ts" }, "projectType"],
		[{ projectType: "rbxts", rojoPort: 0 }, "rojoPort"],
		[{ projectType: "rbxts", rojoPort: 70_000 }, "rojoPort"],
		[{ projectType: "rbxts", rojoPort: 1.5 }, "rojoPort"],
		[{ gracefulTimeoutMs: -1, projectType: "rbxts" }, "gracefulTimeoutMs"],
		[{ projectType: "rbxts", typegen: { maxDepth: 0 } }, "typegen.maxDepth"],
		[{ buildOutputPath: "", projectType: "rbxts" }, "buildOutputPath"],
		[{ projectType: "rbxts", rbxts: { args: "--verbose" } }, "rbxts.args"],
		[{ open: { buildFirst: "yes" }, projectType: "rbxts" }, "open.buildFirst"],
	] as const)("should reject the bad value in %o", ([value, key]) => {
		expect.assertions(2);

		const error = errorOf(() => validateConfigFile(value, FILE));

		expect(error.code).toBe("config_invalid");
		expect(error.message).toContain(`\n${key}`);
	});

	it("should reject a file that exports no object", () => {
		expect.assertions(1);

		expect(errorOf(() => validateConfigFile(undefined, FILE)).code).toBe("config_invalid");
	});

	it("should tell the user how to fix an invalid config", () => {
		expect.assertions(1);

		expect(errorOf(() => validateConfigFile({}, FILE)).hint).toBe(
			"Fix or remove the keys named above.",
		);
	});

	it.for([
		["commandNames", { commandNames: {}, projectType: "rbxts" }, "Use `hooks`"],
		[
			"suppressNoTaskRunnerWarning",
			{ projectType: "rbxts", suppressNoTaskRunnerWarning: true },
			"no longer uses a task runner",
		],
		[
			"syncbackInputPath",
			{ projectType: "rbxts", syncbackInputPath: "x" },
			"syncback.inputPath",
		],
		[
			"typegenOutputPath",
			{ projectType: "rbxts", typegenOutputPath: "x" },
			"typegen.outputPath",
		],
		[
			"rbxts.watchOnOpen",
			{ projectType: "rbxts", rbxts: { watchOnOpen: true } },
			"always runs the compiler",
		],
	] as const)("should name the removed key %s and what replaced it", ([key, value, instead]) => {
		expect.assertions(3);

		const error = errorOf(() => validateConfigFile(value, FILE));

		expect(error.code).toBe("config_removed_key");
		expect(error.message).toStartWith(`${FILE}: \`${key}\` was removed. `);
		expect(error.message).toContain(instead);
	});

	it("should tell the user to delete a removed key", () => {
		expect.assertions(1);

		const error = errorOf(() => {
			return validateConfigFile({ commandNames: {}, projectType: "rbxts" }, FILE);
		});

		expect(error.hint).toBe("Remove `commandNames` from the config file.");
	});

	it("should not mistake a same-named nested key for a removed top-level key", () => {
		expect.assertions(1);

		// `rbxts: null` stops the walk for `rbxts.watchOnOpen` at a non-object.
		expect(
			errorOf(() => validateConfigFile({ projectType: "rbxts", rbxts: null }, FILE)).code,
		).toBe("config_invalid");
	});
});

describe(validateConfigLayer, () => {
	it("should accept a layer without the project type", () => {
		expect.assertions(1);

		expect(
			validateConfigLayer({ rojoPort: 4000 }, () => new ForgeError("usage", "x")),
		).toStrictEqual({ rojoPort: 4000 });
	});

	it("should throw the caller's error, made from each problem and its path", () => {
		expect.assertions(2);

		const error = errorOf(() => {
			return validateConfigLayer({ rojoPort: "x", typegen: { include: [1] } }, (problems) => {
				return new ForgeError("usage", JSON.stringify(problems));
			});
		});

		expect(error.code).toBe("usage");
		expect(JSON.parse(error.message)).toStrictEqual([
			{ message: "rojoPort must be a number (was a string)", path: "rojoPort" },
			{
				message: "typegen.include[0] must be a string (was a number)",
				path: "typegen.include.0",
			},
		]);
	});
});
