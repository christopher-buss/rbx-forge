import { parseArgs } from "node:util";
import { describe, expect, it } from "vitest";

import { catchForgeError } from "../../test/helpers/errors.ts";
import type { FlagDefinition } from "./flags.ts";
import { configLayerFromFlags, GLOBAL_FLAGS, parserOptions } from "./flags.ts";

// One flag per kind, each mapped to a config option.
const FLAGS: ReadonlyArray<FlagDefinition> = [
	{ name: "output", config: "buildOutputPath", kind: "string", text: "t", value: "<path>" },
	{ name: "port", config: "rojoPort", kind: "number", text: "t", value: "<port>" },
	{ name: "build", config: "open.buildFirst", kind: "boolean", text: "t" },
	{ name: "include", config: "typegen.include", kind: "list", text: "t", value: "<glob>" },
	{ name: "depth", config: "typegen.maxDepth", kind: "number", text: "t", value: "<n>" },
	{ name: "dry-run", kind: "boolean", short: "n", text: "t" },
];

function parse(argv: Array<string>): ReturnType<typeof parseArgs>["values"] {
	return parseArgs({ allowNegative: true, args: argv, options: parserOptions(FLAGS) }).values;
}

describe(parserOptions, () => {
	it("should map each kind to a parser type, with no defaults", () => {
		expect.assertions(1);

		expect(parserOptions(FLAGS)).toStrictEqual({
			"build": { type: "boolean" },
			"depth": { type: "string" },
			"dry-run": { short: "n", type: "boolean" },
			"include": { multiple: true, type: "string" },
			"output": { type: "string" },
			"port": { type: "string" },
		});
	});

	it("should leave every flag absent when none is passed", () => {
		expect.assertions(1);

		expect(Object.keys(parse([]))).toStrictEqual([]);
	});

	it("should give the global flags their short aliases", () => {
		expect.assertions(1);

		expect(parserOptions(GLOBAL_FLAGS)).toStrictEqual({
			help: { short: "h", type: "boolean" },
			json: { type: "boolean" },
			version: { short: "v", type: "boolean" },
		});
	});
});

describe(configLayerFromFlags, () => {
	it("should set the option of each passed flag, typed by its kind", () => {
		expect.assertions(1);

		const values = parse([
			"--output=out.rbxl",
			"--port",
			"4000",
			"--no-build",
			"--include",
			"A/**",
			"--include",
			"B/**",
			"--depth",
			"2",
		]);

		expect(configLayerFromFlags(FLAGS, values)).toStrictEqual({
			buildOutputPath: "out.rbxl",
			open: { buildFirst: false },
			rojoPort: 4000,
			typegen: { include: ["A/**", "B/**"], maxDepth: 2 },
		});
	});

	it("should set nothing for flags that were not passed or map to no option", () => {
		expect.assertions(1);

		expect(configLayerFromFlags(FLAGS, parse(["--dry-run"]))).toStrictEqual({});
	});

	it.for([
		[["--port", "abc"], "--port: rojoPort must be a number (was a string)"],
		[["--port", "1.5"], "--port: rojoPort"],
		[["--port", "0"], "--port: rojoPort"],
		[["--output", ""], "--output: buildOutputPath"],
	] as const)("should reject %o as usage, naming the flag", ([argv, message]) => {
		expect.assertions(2);

		const error = catchForgeError(() => configLayerFromFlags(FLAGS, parse([...argv])));

		expect(error.code).toBe("usage");
		expect(error.message).toStartWith(message);
	});

	it("should name every flag with a bad value", () => {
		expect.assertions(1);

		const error = catchForgeError(() => {
			return configLayerFromFlags(FLAGS, parse(["--port", "x", "--depth", "0"]));
		});

		expect(error.message).toBe(
			"--port: rojoPort must be a number (was a string)\n--depth: typegen.maxDepth must be at least 1 (was 0)",
		);
	});

	it("should point a bad flag value at the help page", () => {
		expect.assertions(1);

		const error = catchForgeError(() => configLayerFromFlags(FLAGS, parse(["--port", "x"])));

		expect(error.hint).toBe('Run "forge --help" for usage.');
	});
});
