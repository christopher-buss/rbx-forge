import { describe, expect, it } from "vitest";

import type { ResolvedConfig } from "./resolve.ts";
import { DEFAULT_CONFIG, resolveConfig } from "./resolve.ts";
import type { ConfigLayer, ForgeConfig, HookPhases } from "./schema.ts";

const FILE: ForgeConfig = { projectType: "rbxts" };

interface PrecedenceCase {
	defaultValue: unknown;
	fileLayer: ConfigLayer;
	fileValue: unknown;
	flagLayer: ConfigLayer;
	flagValue: unknown;
	/** Reads the option out of a resolved config. */
	read: (config: ResolvedConfig) => unknown;
	type: string;
}

interface OptionUnderTest<T> {
	read: (config: ResolvedConfig) => T | undefined;
	/** A layer that sets the option to `value`. */
	set: (value: T) => ConfigLayer;
	type: string;
	values: { default: T | undefined; file: T; flag: T };
}

function precedenceCase<T>({ read, set, type, values }: OptionUnderTest<T>): PrecedenceCase {
	return {
		defaultValue: values.default,
		fileLayer: set(values.file),
		fileValue: values.file,
		flagLayer: set(values.flag),
		flagValue: values.flag,
		read,
		type,
	};
}

// One option per value type. Values are written out, not read from the
// defaults, so a changed default fails here.
const CASES: ReadonlyArray<PrecedenceCase> = [
	precedenceCase({
		read: (config) => config.buildOutputPath,
		set: (value: string) => ({ buildOutputPath: value }),
		type: "string",
		values: { default: "game.rbxl", file: "file.rbxl", flag: "flag.rbxl" },
	}),
	precedenceCase({
		read: (config) => config.rojoPort,
		set: (value: number) => ({ rojoPort: value }),
		type: "number",
		values: { default: 34_872, file: 4000, flag: 5000 },
	}),
	precedenceCase({
		read: (config) => config.open.buildFirst,
		set: (value: boolean) => ({ open: { buildFirst: value } }),
		type: "boolean",
		values: { default: true, file: false, flag: true },
	}),
	precedenceCase({
		read: (config) => config.typegen.include,
		set: (value: Array<string>) => ({ typegen: { include: value } }),
		type: "string list",
		values: { default: ["**"], file: ["Workspace/**"], flag: ["ReplicatedStorage/**"] },
	}),
	precedenceCase({
		read: (config) => config.typegen.maxDepth,
		set: (value: number) => ({ typegen: { maxDepth: value } }),
		type: "optional number",
		values: { default: undefined, file: 3, flag: 5 },
	}),
	precedenceCase({
		read: (config) => config.hooks.build,
		set: (value: HookPhases) => ({ hooks: { build: value } }),
		type: "hook record",
		values: { default: undefined, file: { pre: ["lint"] }, flag: { pre: ["format"] } },
	}),
];

function fileWith(layer: ConfigLayer): ForgeConfig {
	return { ...FILE, ...layer };
}

describe(resolveConfig, () => {
	it.for(CASES)("should take the default $type when no layer sets it", (option) => {
		expect.assertions(1);

		expect(option.read(resolveConfig(FILE, {}))).toStrictEqual(option.defaultValue);
	});

	it.for(CASES)("should take the file's $type over the default", (option) => {
		expect.assertions(1);

		const config = resolveConfig(fileWith(option.fileLayer), {});

		expect(option.read(config)).toStrictEqual(option.fileValue);
	});

	it.for(CASES)("should take the flag's $type over the file", (option) => {
		expect.assertions(1);

		const config = resolveConfig(fileWith(option.fileLayer), option.flagLayer);

		expect(option.read(config)).toStrictEqual(option.flagValue);
	});

	it.for(CASES)("should take the flag's $type over the default", (option) => {
		expect.assertions(1);

		const config = resolveConfig(FILE, option.flagLayer);

		expect(option.read(config)).toStrictEqual(option.flagValue);
	});

	it("should take the project type from the file, and a flag over it", () => {
		expect.assertions(2);

		expect(resolveConfig({ projectType: "luau" }, {}).projectType).toBe("luau");
		expect(resolveConfig({ projectType: "luau" }, { projectType: "rbxts" }).projectType).toBe(
			"rbxts",
		);
	});

	it("should merge objects key by key across layers", () => {
		expect.assertions(1);

		const config = resolveConfig(fileWith({ typegen: { outputPath: "out.d.ts" } }), {
			typegen: { maxDepth: 2 },
		});

		expect(config.typegen).toStrictEqual({
			exclude: ["**/node_modules/**"],
			include: ["**"],
			maxDepth: 2,
			outputPath: "out.d.ts",
		});
	});

	it("should replace a hook list, never append to it", () => {
		expect.assertions(1);

		const config = resolveConfig(fileWith({ hooks: { build: { post: ["a"], pre: ["b"] } } }), {
			hooks: { build: { pre: ["c"] } },
		});

		expect(config.hooks).toStrictEqual({ build: { post: ["a"], pre: ["c"] } });
	});

	it("should never change the defaults", () => {
		expect.assertions(1);

		resolveConfig(FILE, {}).typegen.include.push("Workspace/**");

		expect(DEFAULT_CONFIG.typegen.include).toStrictEqual(["**"]);
	});
});
