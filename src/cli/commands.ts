import { BUILD_FLAGS, runBuildCommandAsync } from "../commands/build.ts";
import { runConfigAsync } from "../commands/config.ts";
import type { CommandRun } from "../commands/context.ts";
import { CONFIG_FILE_NAME, INIT_FLAGS, runInitAsync } from "../commands/init.ts";
import { runStartAsync, START_FLAGS } from "../commands/start.ts";
import { runStopAsync } from "../commands/stop.ts";
import type { FlagDefinition } from "./flags.ts";

/** One `forge <command>`: its flags, help line, and what it runs. */
export interface CommandDefinition {
	name: string;
	/** Flags besides the global ones. Parser and help both read this. */
	flags: ReadonlyArray<FlagDefinition>;
	run: CommandRun;
	/** One line for the help page. */
	summary: string;
}

/** Every command, in help order. */
export const COMMANDS: ReadonlyArray<CommandDefinition> = [
	{
		name: "init",
		flags: INIT_FLAGS,
		run: runInitAsync,
		summary: `Create ${CONFIG_FILE_NAME}, and nothing else.`,
	},
	{
		name: "config",
		flags: [],
		run: runConfigAsync,
		summary: "Print the resolved config (flags over the config file over defaults).",
	},
	{
		name: "build",
		flags: BUILD_FLAGS,
		run: runBuildCommandAsync,
		summary: "Build the Rojo project to a place or model file, or a Studio plugin.",
	},
	{
		name: "start",
		flags: START_FLAGS,
		run: runStartAsync,
		summary:
			"Run the dev session in this terminal. Every process it starts stops with it. For now: Rojo only (--no-open --no-compiler).",
	},
	{
		name: "stop",
		flags: [],
		run: runStopAsync,
		summary:
			"Close Roblox Studio for this project's place, after verifying the process is Studio.",
	},
];
