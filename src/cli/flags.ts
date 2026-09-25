import assert from "node:assert/strict";
import type { ParseArgsOptionsConfig } from "node:util";

import type { ConfigLayer, ForgeConfig } from "../config/schema.ts";
import { validateConfigLayer } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";

/** A config option a flag can override, such as `"typegen.include"`. */
export type ConfigOptionPath = OptionPaths<ForgeConfig>;

/**
 * What a flag reads. `boolean` also accepts `--no-<name>`; `list` repeats;
 * `number` is checked by the config schema when the flag sets an option.
 */
export type FlagKind = "boolean" | "list" | "number" | "string";

/**
 * One flag: what the parser needs, plus the help text. There is no default:
 * precedence (flags over config over defaults) is resolved after parsing, in
 * `config/resolve.ts`, so an absent flag lets the layer below show through.
 */
export interface FlagDefinition {
	/** Name without the leading `--`. */
	name: string;
	/** The config option this flag overrides, if any. */
	config?: ConfigOptionPath;
	kind: FlagKind;
	/** One-letter alias. */
	short?: string;
	/** One line of help text. */
	text: string;
	/** The value placeholder in help, such as `<path>`. Not for booleans. */
	value?: string;
}

/** Flag values as the parser returns them. Absent flags have no key. */
export type FlagValues = Readonly<
	Record<string, Array<boolean | string> | boolean | string | undefined>
>;

/**
 * Dotted paths to every config option that holds a value, not an object.
 *
 * @template T - The config shape to walk.
 * @template Prefix - The path so far.
 */
type OptionPaths<T, Prefix extends string = ""> = {
	[K in keyof T & string]-?: NonNullable<T[K]> extends Array<unknown> | boolean | number | string
		? `${Prefix}${K}`
		: OptionPaths<NonNullable<T[K]>, `${Prefix}${K}.`>;
}[keyof T & string];

/** Flags every command reads, in help order. */
export const GLOBAL_FLAGS: ReadonlyArray<FlagDefinition> = [
	{ name: "help", kind: "boolean", short: "h", text: "Show help and exit." },
	{ name: "version", kind: "boolean", short: "v", text: "Print the version and exit." },
	{
		name: "json",
		kind: "boolean",
		text: "Write NDJSON events and a final result object (the default when stdout is not a terminal).",
	},
];

/**
 * Read a `number` flag that sets no config option, such as `--timeout`.
 *
 * @param name - The flag's name, for the error.
 * @param value - Its value as parsed.
 * @param unit - What it counts, such as `seconds`.
 * @param max - The largest value it takes.
 * @returns The number, at least 0.
 * @throws {ForgeError} `usage` when it is not a number from 0 to `max`.
 */
export function readCountFlag(
	name: string,
	value: FlagValues[string],
	unit: string,
	max: number = Number.MAX_SAFE_INTEGER,
): number {
	const count = typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
	if (Number.isNaN(count) || count < 0 || count > max) {
		throw new ForgeError(
			"usage",
			`--${name} takes a number of ${unit}, not "${String(value)}".`,
		);
	}

	return count;
}

/**
 * A flag table in the shape `node:util` `parseArgs` reads. Help is rendered
 * from the same table, so the two cannot drift apart.
 *
 * @param flags - The flags to accept.
 * @returns Parser options with no defaults.
 */
export function parserOptions(flags: ReadonlyArray<FlagDefinition>): ParseArgsOptionsConfig {
	const options: ParseArgsOptionsConfig = {};
	for (const { name, kind, short } of flags) {
		options[name] = {
			...(kind === "boolean" ? { type: "boolean" } : { type: "string" }),
			...(kind === "list" ? { multiple: true } : {}),
			...(short === undefined ? {} : { short }),
		};
	}

	return options;
}

/**
 * The config values the passed flags set: the top layer of the config.
 *
 * @param flags - The flag table of the command.
 * @param values - What the parser read.
 * @returns A config layer holding only options a passed flag set.
 * @throws {ForgeError} `usage` when a value breaks the config schema, naming
 *   the flag.
 */
export function configLayerFromFlags(
	flags: ReadonlyArray<FlagDefinition>,
	values: FlagValues,
): ConfigLayer {
	const layer: Record<string, unknown> = {};
	for (const { name, config, kind } of flags) {
		const raw = values[name];
		if (config !== undefined && raw !== undefined) {
			setPath(layer, config, kind === "number" ? toNumber(raw) : raw);
		}
	}

	return validateConfigLayer(layer, (problems) => {
		const lines = problems.map(({ message, path }) => {
			return `--${flagFor(flags, path).name}: ${message}`;
		});
		return new ForgeError("usage", lines.join("\n"), { hint: 'Run "forge --help" for usage.' });
	});
}

/**
 * Find the flag that set a config value.
 *
 * @param flags - The flag table.
 * @param path - Dotted path of the value. List flags hold strings, which
 *   always pass, so a problem path is always a flag's own option.
 * @returns The flag whose option holds the path.
 */
function flagFor(flags: ReadonlyArray<FlagDefinition>, path: string): FlagDefinition {
	const flag = flags.find(({ config }) => config === path);
	assert(flag !== undefined);
	return flag;
}

const NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * Read a number flag. Anything that is not a plain decimal stays a string, so
 * the schema reports it as the wrong type.
 *
 * @param raw - The flag's text.
 * @returns The number, or `raw` unchanged.
 */
function toNumber(raw: FlagValues[string]): FlagValues[string] | number {
	return typeof raw === "string" && NUMBER.test(raw) ? Number(raw) : raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	// Only flag values and objects made here reach it: never `null`.
	return typeof value === "object" && !Array.isArray(value);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const [key, ...rest] = path.split(".");
	assert(key !== undefined);
	if (rest.length === 0) {
		target[key] = value;
		return;
	}

	const below = target[key];
	const child = isRecord(below) ? below : {};
	target[key] = child;
	setPath(child, rest.join("."), value);
}
