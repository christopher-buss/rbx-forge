import { log, taskLog } from "@clack/prompts";

import ansis from "ansis";
import { execa } from "execa";
import { createInterface } from "node:readline";

import { loadProjectConfig } from "../config";

export const COMMAND = "compile";
export const DESCRIPTION = "Compile TypeScript to Luau";

export async function action(): Promise<void> {
	const config = await loadProjectConfig();

	const rbxtsc = "rbxtsc";
	const rbxtscArgs = config.rbxtscArgs ?? ["--verbose"];

	log.info(ansis.bold("→ Compiling TypeScript"));
	log.step(`Compiler: ${ansis.cyan(rbxtsc)}`);
	log.step(`Arguments: ${ansis.dim(rbxtscArgs.join(" "))}`);

	await runCompilation(rbxtsc, rbxtscArgs);
}

function formatDuration(startTime: number): string {
	const endTime = performance.now();
	const duration = ((endTime - startTime) / 1000).toFixed(1);
	return `${duration}s`;
}

async function runCompilation(rbxtsc: string, rbxtscArgs: ReadonlyArray<string>): Promise<void> {
	const startTime = performance.now();

	const taskLogger = taskLog({
		limit: 12,
		title: "Compiling TypeScript...",
	});

	try {
		const subprocess = execa(rbxtsc, rbxtscArgs, {
			all: true,
			buffer: false,
		});

		const rl = createInterface({
			crlfDelay: Number.POSITIVE_INFINITY,
			input: subprocess.all,
		});

		rl.on("line", (line) => {
			taskLogger.message(line);
		});

		await subprocess;

		const stats = formatDuration(startTime);
		taskLogger.success(`Compilation complete (${ansis.dim(stats)})`);
	} catch (err) {
		const stats = formatDuration(startTime);
		taskLogger.error(`Compilation failed (${ansis.dim(stats)})`);
		throw err;
	}
}
