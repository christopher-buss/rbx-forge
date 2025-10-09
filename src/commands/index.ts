import * as buildCmd from "./build";
import * as initCmd from "./init";
import * as serveCmd from "./serve";

export const COMMANDS = [buildCmd, initCmd, serveCmd] as const;

/** Commands that should not be added as task runner scripts. */
const EXCLUDED_COMMANDS = ["init"] as const;

/**
 * Script names that will be added to task runners (npm, mise, etc.).
 * Automatically derived from registered commands, excluding non-scriptable
 * commands.
 */
export const SCRIPT_NAMES = COMMANDS.map((cmd) => cmd.COMMAND).filter(
	(name) => !EXCLUDED_COMMANDS.includes(name as never),
) as ReadonlyArray<string>;

export type ScriptName = (typeof SCRIPT_NAMES)[number];

export * as buildCmd from "./build";
export * as initCmd from "./init";
export * as serveCmd from "./serve";
