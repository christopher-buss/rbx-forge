import { log } from "@clack/prompts";

import ansis from "ansis";
import { stat } from "node:fs/promises";

import { loadProjectConfig } from "../config";
import { formatDuration } from "../utils/format-duration";
import { getRojoCommand } from "../utils/get-rojo-command";
import { createSpinner, run } from "../utils/run";

export const COMMAND = "build";
export const DESCRIPTION = "Build the Rojo project";

export async function action(): Promise<void> {
	const config = await loadProjectConfig();
	const rojo = getRojoCommand();
	const outputPath = config.buildOutputPath;

	log.info(ansis.bold("→ Building project"));
	log.step(`Output: ${ansis.cyan(outputPath)}`);

	const startTime = performance.now();

	const spinner = createSpinner("Building project...");
	await run(rojo, ["build", "--output", outputPath], {
		shouldStreamOutput: false,
	});

	const duration = formatDuration(startTime);

	let fileSize = "";
	try {
		const stats = await stat(outputPath);
		const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
		fileSize = `${sizeMb} MB`;
	} catch {
		fileSize = "";
	}

	const stats = [outputPath, fileSize, duration].filter(Boolean).join(", ");
	spinner.stop(`Build complete (${ansis.dim(stats)})`);
}
