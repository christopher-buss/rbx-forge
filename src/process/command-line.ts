import type { Environment } from "../seams/seams.ts";
import { readVariable } from "./environment.ts";
import type { ProcessSpec } from "./process-runner.ts";

/** The executable and arguments of a {@link ProcessSpec}. */
export type Invocation = Pick<ProcessSpec, "args" | "file" | "verbatimArguments">;

// cmd.exe metacharacters, escaped with `^`. See
// https://www.robvanderwoude.com/escapechars.php (as cross-spawn does).
const CMD_METACHARACTERS = /([ !"%&()*,;<>?[\]^`|])/g;

/**
 * Run a command line through the system shell: `cmd.exe` on Windows,
 * `/bin/sh` elsewhere. This is what hooks run through; the command line is
 * the user's, so it is passed on unchanged.
 *
 * @param command - The shell command line.
 * @param platform - The OS.
 * @param environment - Holds `ComSpec`, the Windows shell.
 * @returns The executable and arguments to spawn.
 */
export function shellInvocation(
	command: string,
	platform: NodeJS.Platform,
	environment: Environment,
): Invocation {
	if (platform === "win32") {
		return {
			args: ["/d", "/s", "/c", `"${command}"`],
			file: comspec(environment),
			verbatimArguments: true,
		};
	}

	return { args: ["-c", command], file: "/bin/sh" };
}

/**
 * Run a Windows batch file (`.cmd` or `.bat`), which Node cannot spawn
 * directly. Each argument is quoted and its cmd.exe metacharacters escaped
 * twice: once for this cmd.exe, and once more because a tool shim passes its
 * arguments (`%*`) to a second command line that cmd.exe parses again.
 *
 * @param file - Path of the `.cmd` or `.bat` file.
 * @param args - Plain arguments, escaped here.
 * @param environment - Holds `ComSpec`, the Windows shell.
 * @returns The executable and arguments to spawn.
 */
export function batchInvocation(
	file: string,
	args: ReadonlyArray<string>,
	environment: Environment,
): Invocation {
	const line = [escapeMetacharacters(file), ...args.map(quoteArgument)].join(" ");
	return {
		args: ["/d", "/s", "/c", `"${line}"`],
		file: comspec(environment),
		verbatimArguments: true,
	};
}

function comspec(environment: Environment): string {
	return readVariable(environment, "ComSpec", "win32") ?? "cmd.exe";
}

function escapeMetacharacters(text: string): string {
	return text.replaceAll(CMD_METACHARACTERS, "^$1");
}

/**
 * Quote one argument the way the Microsoft C runtime reads it back
 * (https://qntm.org/cmd), then escape it for cmd.exe twice. Backslashes are
 * literal except before a quote: those double, and the quote gets one more.
 *
 * @param argument - One plain argument.
 * @returns The escaped argument.
 */
function quoteArgument(argument: string): string {
	let quoted = "";
	let backslashes = 0;
	for (const character of argument) {
		if (character === "\\") {
			backslashes += 1;
			continue;
		}

		quoted +=
			character === '"'
				? `${"\\".repeat(backslashes * 2 + 1)}"`
				: `${"\\".repeat(backslashes)}${character}`;
		backslashes = 0;
	}

	// Trailing backslashes come before the closing quote, so they double.
	quoted += "\\".repeat(backslashes * 2);
	return escapeMetacharacters(escapeMetacharacters(`"${quoted}"`));
}
