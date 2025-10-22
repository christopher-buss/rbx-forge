import * as buildCmd from "./build";
import * as compileCmd from "./compile";
import * as initCmd from "./init";
import * as openCmd from "./open";
import * as serveCmd from "./serve";
import * as startCmd from "./start";
import * as stopCmd from "./stop";
import type { Command } from "./types";
import * as watchCmd from "./watch";

export const COMMANDS = [
	initCmd,
	buildCmd,
	compileCmd,
	openCmd,
	serveCmd,
	startCmd,
	stopCmd,
	watchCmd,
] as const satisfies ReadonlyArray<Command | Command<buildCmd.BuildOptions | openCmd.OpenOptions>>;

/** Commands that should not be added as task runner scripts. */
const EXCLUDED_COMMANDS = ["init"] as const;

/**
 * Script names that will be added to task runners (npm, mise, etc.).
 * Automatically derived from registered commands, excluding non-scriptable
 * commands.
 */
export const SCRIPT_NAMES = COMMANDS.map((cmd) => cmd.COMMAND).filter(
	(name) => !EXCLUDED_COMMANDS.includes(name as never),
) as ReadonlyArray<Exclude<(typeof COMMANDS)[number]["COMMAND"], "init">>;
export type ScriptName = (typeof SCRIPT_NAMES)[number];

export * as buildCmd from "./build";
export * as compileCmd from "./compile";
export * as initCmd from "./init";
export * as openCmd from "./open";
export * as serveCmd from "./serve";
export * as startCmd from "./start";
export * as stopCmd from "./stop";
export * as watchCmd from "./watch";
