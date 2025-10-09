import { cancel } from "@clack/prompts";

import ansis from "ansis";
import process from "node:process";

import { COMMANDS, SCRIPT_NAMES } from "../commands";
import { run, runOutput } from "./run";

export async function checkMiseInstallation(): Promise<boolean> {
	try {
		await runOutput("mise", ["version"]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Adds rbx-forge tasks to mise using the mise CLI. Exits with code 2 if mise is
 * not installed.
 *
 * @returns Success message.
 */
export async function updateMiseToml(): Promise<string> {
	const isMiseInstalled = await checkMiseInstallation();
	if (!isMiseInstalled) {
		cancel(ansis.yellow("⚠ mise not found - please install mise to continue"));
		process.exit(2);
	}

	const scriptableCommands = COMMANDS.filter((cmd) => SCRIPT_NAMES.includes(cmd.COMMAND));

	for (const cmd of scriptableCommands) {
		const taskName = cmd.COMMAND;
		const description = cmd.DESCRIPTION;

		await run(
			"mise",
			["task", "add", taskName, "--description", description, "--", "rbx-forge", taskName],
			{
				shouldShowCommand: false,
				shouldStreamOutput: false,
			},
		);
	}

	return `Added tasks to ${ansis.magenta("mise.toml")}`;
}
