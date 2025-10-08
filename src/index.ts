import { log } from "@clack/prompts";

import { Command } from "commander";
import process from "node:process";

import { version as packageVersion } from "../package.json";
import * as buildCmd from "./commands/build";
import * as initCmd from "./commands/init";
import * as serveCmd from "./commands/serve";

const program = new Command();

async function main(): Promise<void> {
	program
		.name("rbxts-forge")
		.description("A CLI tool for fully-managed rojo projects")
		.version(packageVersion, "-v, --version", "output the current version")
		.helpOption("-h, --help", "display help for command")
		.showHelpAfterError();

	const commands = [buildCmd, initCmd, serveCmd];

	for (const cmd of commands) {
		program.command(cmd.command).description(cmd.description).action(cmd.action);
	}

	await program.parseAsync(process.argv);
}

main().catch((err) => {
	log.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
