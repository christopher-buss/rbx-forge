import { BUILD_FLAGS, runBuildCommandAsync } from "../commands/build.ts";
import { runConfigAsync } from "../commands/config.ts";
import type { CommandRun } from "../commands/context.ts";
import { CONFIG_FILE_NAME, INIT_FLAGS, runInitAsync } from "../commands/init.ts";
import { OPEN_FLAGS, runOpenAsync } from "../commands/open.ts";
import { runStopAsync } from "../commands/stop.ts";
import { runSyncbackCommandAsync, SYNCBACK_FLAGS } from "../commands/syncback.ts";
import { runTypegenCommandAsync, TYPEGEN_FLAGS } from "../commands/typegen.ts";
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
		name: "open",
		flags: OPEN_FLAGS,
		run: runOpenAsync,
		summary: "Open the place in Roblox Studio, building it first when configured or asked.",
	},
	{
		name: "stop",
		flags: [],
		run: runStopAsync,
		summary:
			"Close Roblox Studio for this project's place, after verifying the process is Studio.",
	},
	{
		name: "syncback",
		flags: SYNCBACK_FLAGS,
		run: runSyncbackCommandAsync,
		summary: "Sync the place file back into the project once (needs the Rojo syncback fork).",
	},
	{
		name: "typegen",
		flags: TYPEGEN_FLAGS,
		run: runTypegenCommandAsync,
		summary: "Write TypeScript types for the Rojo project's services from its sourcemap.",
	},
];
