import type { ParseArgsOptionsConfig } from "node:util";

/** One global flag: what the parser needs, plus the help text. */
export interface FlagDefinition {
	name: string;
	/** One-letter alias. */
	short: string;
	/** One line of help text. */
	text: string;
	type: "boolean";
}

/**
 * Global flags, in help order. The parser options and the help page are both
 * built from this table, so they cannot drift apart. Defaults are never set
 * here: precedence (flags over config over defaults) is resolved after
 * parsing.
 */
export const FLAGS: ReadonlyArray<FlagDefinition> = [
	{ name: "help", short: "h", text: "Show this help and exit.", type: "boolean" },
	{ name: "version", short: "v", text: "Print the version and exit.", type: "boolean" },
];

/**
 * The flag table in the shape `node:util` `parseArgs` reads.
 *
 * @returns Parser options for every flag in {@link FLAGS}.
 */
export function parserOptions(): ParseArgsOptionsConfig {
	const options: ParseArgsOptionsConfig = {};
	for (const { name, short, type } of FLAGS) {
		options[name] = { short, type };
	}

	return options;
}
