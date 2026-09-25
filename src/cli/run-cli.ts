import assert from "node:assert/strict";
import { parseArgs } from "node:util";

import { EXIT_SUCCESS, EXIT_USAGE } from "../exit-codes.ts";
import type { ExitCode } from "../exit-codes.ts";
import { parserOptions } from "./flags.ts";
import { renderHelp } from "./help.ts";

export interface CliContext {
	/** Where the CLI writes. The entry passes the process streams. */
	output: {
		stderr: (text: string) => void;
		stdout: (text: string) => void;
	};
	/** The package version `--version` prints. */
	version: string;
}

/**
 * Run one `forge` invocation. Reads only its arguments and context and never
 * exits the process: the entry writes the returned code.
 *
 * @param argv - Arguments after the executable and script path.
 * @param context - Output sinks and the package version.
 * @returns The exit code for the process.
 */
export function runCli(argv: ReadonlyArray<string>, { output, version }: CliContext): ExitCode {
	let parsed;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			args: [...argv],
			options: parserOptions(),
			strict: true,
		});
	} catch (err) {
		assert(err instanceof TypeError, "parseArgs throws only TypeError");
		output.stderr(`forge: ${err.message}\nRun "forge --help" for usage.\n`);
		return EXIT_USAGE;
	}

	const [command] = parsed.positionals;
	if (command !== undefined) {
		output.stderr(`forge: unknown command "${command}"\nRun "forge --help" for usage.\n`);
		return EXIT_USAGE;
	}

	if (parsed.values["version"] === true) {
		output.stdout(`${version}\n`);
		return EXIT_SUCCESS;
	}

	output.stdout(renderHelp());
	return EXIT_SUCCESS;
}
