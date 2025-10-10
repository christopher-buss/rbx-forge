#!/usr/bin/env node
import { intro, log } from "@clack/prompts";

import ansis from "ansis";
import { Command } from "commander";
import process from "node:process";

import { version as packageVersion } from "../package.json";
import { COMMANDS } from "./commands";

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

	for (const cmd of COMMANDS) {
		/**
		 * Wrap action with intro (except for init which has its own).
		 *
		 * @param args - Command arguments.
		 */
		async function wrappedAction(...args: Array<unknown>): Promise<void> {
			if (cmd.COMMAND !== "init") {
				intro(ansis.bold(`🔨 rbx-forge ${cmd.COMMAND}`));
			}

			await cmd.action(...args);
		}

		program.command(cmd.COMMAND).description(cmd.DESCRIPTION).action(wrappedAction);
	}

	await program.parseAsync(process.argv);
}

main().catch((err) => {
	log.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
