import assert from "node:assert/strict";
import { parseArgs } from "node:util";

import type { CommandContext } from "../commands/context.ts";
import { ForgeError } from "../errors.ts";
import { EXIT_SUCCESS } from "../exit-codes.ts";
import type { ExitCode } from "../exit-codes.ts";
import { createReporter } from "../output/reporters.ts";
import type { OutputStreams, Reporter } from "../seams/reporter.ts";
import type { Environment, Seams } from "../seams/seams.ts";
import type { CommandDefinition } from "./commands.ts";
import type { FlagValues } from "./flags.ts";
import { configLayerFromFlags, GLOBAL_FLAGS, parserOptions } from "./flags.ts";
import { renderCommandHelp, renderHelp } from "./help.ts";

/** What the CLI entry hands to one run. */
export interface CliContext {
	/** Every command the CLI knows. The entry passes `COMMANDS`. */
	commands: ReadonlyArray<CommandDefinition>;
	cwd: string;
	env: Environment;
	output: OutputStreams;
	seams: Seams;
	/** Whether stdin and stdout are terminals. */
	terminal: { stdinIsTty: boolean; stdoutIsTty: boolean };
	/** The package version `--version` prints. */
	version: string;
}

const USAGE_HINT = 'Run "forge --help" for usage.';

/**
 * Run one `forge` invocation. Reads only its arguments and context, never
 * throws, and never exits the process: the entry writes the returned code.
 *
 * @param argv - Arguments after the executable and script path.
 * @param context - Commands, seams, output, and terminal facts.
 * @returns The exit code for the process.
 */
export async function runCliAsync(
	argv: ReadonlyArray<string>,
	context: CliContext,
): Promise<ExitCode> {
	const isJson = wantsJson(argv);
	const reporter = createReporter(
		{ json: isJson, stdoutIsTty: context.terminal.stdoutIsTty },
		context.output,
	);

	let command: CommandDefinition | undefined;
	try {
		command = findCommand(argv, context.commands);
		const values = parseValues(argv, command);
		const page = pageFor(command, values, context);
		if (page !== undefined || command === undefined) {
			context.output.stdout(page ?? renderHelp(context.commands));
			return EXIT_SUCCESS;
		}

		const result = await command.run(commandContext(context, reporter, isJson), {
			config: configLayerFromFlags(command.flags, values),
			flags: values,
		});
		reporter.succeed(command.name, result);
		return EXIT_SUCCESS;
	} catch (err) {
		return reportFailure(reporter, command?.name, err);
	}
}

/**
 * The page `--help` or `--version` prints instead of running a command.
 *
 * @param command - The command read, if any.
 * @param values - The parsed flags.
 * @param context - The commands and version.
 * @returns The page, or `undefined` to run the command.
 */
function pageFor(
	command: CommandDefinition | undefined,
	values: FlagValues,
	{ commands, version }: CliContext,
): string | undefined {
	if (values["help"] === true) {
		return command === undefined ? renderHelp(commands) : renderCommandHelp(command);
	}

	return values["version"] === true ? `${version}\n` : undefined;
}

function isCi(environment: Environment): boolean {
	const ci = environment["CI"];
	return ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
}

function commandContext(
	{ cwd, env, seams, terminal }: CliContext,
	reporter: Reporter,
	isJson: boolean,
): CommandContext {
	return {
		cwd,
		env,
		interactive: terminal.stdinIsTty && terminal.stdoutIsTty && !isJson && !isCi(env),
		reporter,
		seams,
	};
}

/**
 * Read `--json` before strict parsing, so a bad command line is reported in
 * the format the caller asked for.
 *
 * @param argv - The arguments.
 * @returns Whether `--json` was passed.
 */
function wantsJson(argv: ReadonlyArray<string>): boolean {
	const { values } = parseArgs({
		allowPositionals: true,
		args: [...argv],
		options: parserOptions(GLOBAL_FLAGS),
		strict: false,
	});
	return values["json"] === true;
}

/**
 * Find the command: the first argument that is not a flag.
 *
 * @param argv - The arguments.
 * @param commands - Every command.
 * @returns The command, or `undefined` when no argument names one.
 */
function findCommand(
	argv: ReadonlyArray<string>,
	commands: ReadonlyArray<CommandDefinition>,
): CommandDefinition | undefined {
	const name = argv.find((argument) => !argument.startsWith("-"));
	const command = commands.find((candidate) => candidate.name === name);
	if (name !== undefined && command === undefined) {
		throw new ForgeError("usage", `Unknown command "${name}".`, { hint: USAGE_HINT });
	}

	return command;
}

function parseValues(
	argv: ReadonlyArray<string>,
	command: CommandDefinition | undefined,
): FlagValues {
	let parsed;
	try {
		parsed = parseArgs({
			allowNegative: true,
			allowPositionals: true,
			args: [...argv],
			options: parserOptions([...GLOBAL_FLAGS, ...(command?.flags ?? [])]),
			strict: true,
		});
	} catch (err) {
		// parseArgs reports every bad argument as a TypeError.
		assert(err instanceof TypeError);
		throw new ForgeError("usage", err.message, { cause: err, hint: USAGE_HINT });
	}

	const [, extra] = parsed.positionals;
	if (extra !== undefined) {
		throw new ForgeError("usage", `Unexpected argument "${extra}".`, { hint: USAGE_HINT });
	}

	return parsed.values;
}

function toForgeError(err: unknown): ForgeError {
	if (err instanceof ForgeError) {
		return err;
	}

	const message = err instanceof Error ? err.message : String(err);
	return new ForgeError("internal_error", message, {
		cause: err,
		hint: "This is a bug in forge. Please report it.",
	});
}

function reportFailure(reporter: Reporter, command: string | undefined, err: unknown): ExitCode {
	const error = toForgeError(err);

	reporter.fail({
		code: error.code,
		command,
		details: error.details,
		exitCode: error.exitCode,
		hint: error.hint,
		message: error.message,
	});

	return error.exitCode;
}
