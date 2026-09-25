import type { FlagValues } from "../cli/flags.ts";
import type { ConfigLayer } from "../config/schema.ts";
import type { CommandResult, Reporter } from "../seams/reporter.ts";
import type { Environment, Seams } from "../seams/seams.ts";

/** What every command runs with. Built once per run by `cli/run-cli.ts`. */
export interface CommandContext {
	/** The project directory. */
	cwd: string;
	env: Environment;
	/**
	 * The run may prompt: stdin and stdout are terminals, `--json` is off,
	 * and it is not CI. When false, questions take their unattended answer or
	 * fail with `needs_confirmation` (`commands/ask.ts`).
	 */
	interactive: boolean;
	reporter: Reporter;
	seams: Seams;
}

/** What a command read from its command line. */
export interface CommandInput {
	/** The positional argument, for a command that reads one. */
	argument?: string;
	/** The config values its flags set; pass to `loadProjectConfigAsync`. */
	config: ConfigLayer;
	/** Every flag value, by flag name. */
	flags: FlagValues;
}

/** Run one command. Returns its result; throws `ForgeError` on failure. */
export type CommandRun = (context: CommandContext, input: CommandInput) => Promise<CommandResult>;
