import { log } from "@clack/prompts";

import { Command } from "commander";
import process from "node:process";

import { version as packageVersion } from "../package.json";
import { COMMANDS } from "./commands";
import { loadProjectConfig } from "./config";
import { getCommandName } from "./utils/command-names";

export { defineConfig } from "./config";
export type { Config } from "./config/schema";

const program = new Command();

async function main(): Promise<void> {
	program
		.name("rbx-forge")
		.description("A CLI tool for fully-managed rojo projects")
		.version(packageVersion, "-v, --version", "output the current version")
		.helpOption("-h, --help", "display help for command")
		.showHelpAfterError();

	const config = await loadProjectConfig();

	for (const cmd of COMMANDS) {
		const commandName = getCommandName(cmd.COMMAND, config);
		program.command(commandName).description(cmd.DESCRIPTION).action(cmd.action);
	}

	await program.parseAsync(process.argv);
}

main().catch((err) => {
	log.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
