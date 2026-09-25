import { BUILD_FLAGS, runBuildCommandAsync } from "../commands/build.ts";
import { runCompileCommandAsync } from "../commands/compile.ts";
import { runConfigAsync } from "../commands/config.ts";
import type { CommandRun } from "../commands/context.ts";
import { CONFIG_FILE_NAME, INIT_FLAGS, runInitAsync } from "../commands/init.ts";
import { LOG_NAMES, LOGS_FLAGS, runLogsAsync } from "../commands/logs.ts";
import { OPEN_FLAGS, runOpenAsync } from "../commands/open.ts";
import { runStartAsync, START_FLAGS } from "../commands/start.ts";
import { runStatusAsync } from "../commands/status.ts";
import { runStopAsync } from "../commands/stop.ts";
import { runSyncAsync } from "../commands/sync.ts";
import { runSyncbackCommandAsync, SYNCBACK_FLAGS } from "../commands/syncback.ts";
import { runTypegenCommandAsync, TYPEGEN_FLAGS } from "../commands/typegen.ts";
import { runUpAsync, UP_FLAGS } from "../commands/up.ts";
import type { FlagDefinition } from "./flags.ts";

/** One `forge <command>`: its flags, help line, and what it runs. */
export interface CommandDefinition {
	name: string;
	/**
	 * The one positional argument the command reads, such as `service` for
	 * `forge logs <service>`. Commands without one reject any.
	 */
	argument?: { name: string; text: string };
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
		name: "compile",
		flags: [],
		run: runCompileCommandAsync,
		summary: "Compile the roblox-ts project once and report its errors (rbxts only).",
	},
	{
		name: "open",
		flags: OPEN_FLAGS,
		run: runOpenAsync,
		summary: "Open the place in Roblox Studio, building it first when configured or asked.",
	},
	{
		name: "start",
		flags: START_FLAGS,
		run: runStartAsync,
		summary:
			"Run the dev session in this terminal: compile, build, open Studio, serve Rojo, and watch. Every process it starts stops with it.",
	},
	{
		name: "up",
		flags: UP_FLAGS,
		run: runUpAsync,
		summary:
			"Start the dev session in the background, as start does, and return once Rojo and the compiler are ready. Reports the running session if there is one.",
	},
	{
		name: "status",
		flags: [],
		run: runStatusAsync,
		summary:
			"Show the running session: each service, the Rojo port, the last compile with its diagnostics, and the last syncback with its hooks.",
	},
	{
		name: "sync",
		flags: [],
		run: runSyncAsync,
		summary:
			"Run syncback and its hooks through the running session, one run at a time with its save watch, and report the result.",
	},
	{
		name: "logs",
		argument: {
			name: "name",
			text: `The log to read: ${LOG_NAMES.join(", ")}.`,
		},
		flags: LOGS_FLAGS,
		run: runLogsAsync,
		summary: "Print a service's full log; --follow keeps printing new lines.",
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
