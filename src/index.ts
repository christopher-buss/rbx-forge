#!/usr/bin/env node
import { intro, log } from "@clack/prompts";

import ansis from "ansis";
import { Command } from "commander";
import process from "node:process";

import { version as packageVersion } from "../package.json";
import { COMMANDS } from "./commands";
import { loadProjectConfig } from "./config";

export { defineConfig } from "./config";
export type { Config } from "./config/schema";

const program = new Command();

const skipLuau = new Set(["compile", "typegen"]);

async function main(): Promise<void> {
	program
		.name("rbx-forge")
		.alias("forge")
		.alias("fge")
		.description("A CLI tool for fully-managed rojo projects")
		.version(packageVersion, "-v, --version", "output the current version")
		.helpOption("-h, --help", "display help for command")
		.showHelpAfterError();

	const { projectType } = await loadProjectConfig();

	for (const cmd of COMMANDS) {
		if (projectType === "luau" && skipLuau.has(cmd.COMMAND)) {
			continue;
		}

		registerCommand(cmd);
	}

	await program.parseAsync(process.argv);
}

function registerCommand(cmd: (typeof COMMANDS)[number]): void {
	const command = program.command(cmd.COMMAND).description(cmd.DESCRIPTION);

	if ("options" in cmd) {
		for (const option of cmd.options) {
			command.option(option.flags, option.description);
		}
	}

	command.action(async (commandOptions: Parameters<typeof cmd.action>[0] | undefined) => {
		process.env["RBX_FORGE_CMD"] ??= cmd.COMMAND;

		if (cmd.COMMAND !== "init") {
			intro(ansis.bold(`🔨 rbx-forge ${cmd.COMMAND}`));
		}

		await (cmd.action as (options?: typeof commandOptions) => Promise<void>)(commandOptions);
	});
}

main().catch((err) => {
	log.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
