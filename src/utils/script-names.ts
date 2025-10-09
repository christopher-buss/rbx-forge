import { COMMANDS } from "../commands";

/** Commands that should not be added to package.json as npm scripts. */
const EXCLUDED_COMMANDS = ["init", "test"] as const;

/**
 * Script names that will be added to package.json when npm is selected as a
 * task runner. Automatically derived from registered commands, excluding
 * non-scriptable commands.
 */
export const SCRIPT_NAMES = COMMANDS.map((cmd) => cmd.COMMAND).filter(
	(name) => !EXCLUDED_COMMANDS.includes(name as never),
) as ReadonlyArray<string>;

export type ScriptName = (typeof SCRIPT_NAMES)[number];
