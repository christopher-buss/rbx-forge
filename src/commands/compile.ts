import { log } from "@clack/prompts";

import ansis from "ansis";

import { loadProjectConfig } from "../config";
import { formatDuration } from "../utils/format-duration";
import { runWithTaskLog } from "../utils/run";

export const COMMAND = "compile";
export const DESCRIPTION = "Compile TypeScript to Luau";

export async function action(): Promise<void> {
	const config = await loadProjectConfig();

	const rbxtsc = config.rbxts.command;
	const rbxtscArgs = config.rbxts.args;

	log.info(ansis.bold("→ Compiling TypeScript"));
	log.step(`Compiler: ${ansis.cyan(rbxtsc)}`);
	log.step(`Arguments: ${ansis.dim(rbxtscArgs.join(" "))}`);

	await runCompilation(rbxtsc, rbxtscArgs);
}

async function runCompilation(rbxtsc: string, rbxtscArgs: ReadonlyArray<string>): Promise<void> {
	const startTime = performance.now();

	const { subprocess, taskLogger } = runWithTaskLog(rbxtsc, rbxtscArgs, {
		taskName: "Compiling TypeScript...",
	});

	try {
		await subprocess;
		const stats = formatDuration(startTime);
		taskLogger.success(`Compilation complete (${ansis.dim(stats)})`);
	} catch (err) {
		const stats = formatDuration(startTime);
		taskLogger.error(`Compilation failed (${ansis.dim(stats)})`);
		throw err;
	}
}
