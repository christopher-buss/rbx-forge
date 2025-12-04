import ansis from "ansis";
import yoctoSpinner from "yocto-spinner";

import { loadProjectConfig } from "../config";
import { formatDuration } from "../utils/format-duration";
import { logger } from "../utils/logger";
import { runStreaming } from "../utils/run";

export const COMMAND = "compile";
export const DESCRIPTION = "Compile TypeScript to Luau";

export async function action(): Promise<void> {
	const config = await loadProjectConfig();

	const rbxtsc = config.rbxts.command;
	const rbxtscArgs = config.rbxts.args;

	logger.info(ansis.bold("→ Compiling TypeScript"));
	logger.step(`Compiler: ${ansis.cyan(rbxtsc)}`);
	logger.step(`Arguments: ${ansis.dim(rbxtscArgs.join(" "))}`);

	await runCompilation(rbxtsc, rbxtscArgs);
}

async function runCompilation(rbxtsc: string, rbxtscArgs: ReadonlyArray<string>): Promise<void> {
	const startTime = performance.now();
	const spinner = yoctoSpinner({ text: "Compiling TypeScript..." }).start();

	const result = runStreaming(rbxtsc, rbxtscArgs, { shouldShowCommand: false });

	try {
		await result.exitCode;
		const stats = formatDuration(startTime);
		spinner.success(`Compilation complete (${ansis.dim(stats)})`);
	} catch (err) {
		const stats = formatDuration(startTime);
		spinner.error(`Compilation failed (${ansis.dim(stats)})`);
		throw err;
	}
}
