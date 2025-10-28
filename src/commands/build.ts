import { log } from "@clack/prompts";

import ansis from "ansis";
import { stat } from "node:fs/promises";
import process from "node:process";
import { getRojoCommand } from "src/utils/rojo";

import { loadProjectConfig } from "../config";
import { formatDuration } from "../utils/format-duration";
import { setupSignalHandlers } from "../utils/process-manager";
import { createSpinner, run } from "../utils/run";

export const COMMAND = "build";
export const DESCRIPTION = "Build the Rojo project";

export const options = [
	{
		description:
			"Where to output the result (overrides config). Should end in .rbxm, .rbxl, .rbxmx, or .rbxlx",
		flags: "-o, --output <path>",
	},
	{
		description: "Output to local plugins folder. Should end in .rbxm or .rbxl",
		flags: "-p, --plugin <name>",
	},
	{
		description: "Sets verbosity level. Can be specified multiple times",
		flags: "-v, --verbose",
	},
	{
		description: "Automatically rebuild when any input files change",
		flags: "-w, --watch",
	},
	{
		description: "Set color behavior (auto, always, or never)",
		flags: "--color <mode>",
	},
	{
		description: "Path to the project to build (defaults to current directory)",
		flags: "--project <path>",
	},
] as const;

export interface BuildOptions {
	color?: string;
	output?: string;
	plugin?: string;
	project?: string;
	verbose?: boolean | number;
	watch?: boolean;
}

export async function action(commandOptions: BuildOptions = {}): Promise<void> {
	validateOptions(commandOptions);

	const config = await loadProjectConfig();
	const rojo = getRojoCommand();

	const outputPath = commandOptions.plugin ?? commandOptions.output ?? config.buildOutputPath;
	const isPluginOutput = commandOptions.plugin !== undefined;
	const rojoArgs = buildRojoArguments(commandOptions, outputPath, isPluginOutput);

	displayBuildInfo(outputPath, isPluginOutput);

	if (commandOptions.watch === true) {
		setupSignalHandlers();
	}

	const startTime = performance.now();
	const spinner = createSpinner("Building project...");

	await run(rojo, rojoArgs, {
		shouldRegisterProcess: commandOptions.watch === true,
		shouldStreamOutput: commandOptions.verbose !== undefined || commandOptions.watch === true,
	});

	const duration = formatDuration(startTime);
	const fileSize = await getFileSize(outputPath, isPluginOutput);
	const statsDisplay = [outputPath, fileSize, duration].filter(Boolean).join(", ");

	spinner.stop(`Build complete (${ansis.dim(statsDisplay)})`);
}

function buildRojoArguments(
	buildOptions: BuildOptions,
	outputPath: string,
	isPluginOutput: boolean,
): Array<string> {
	const args = ["build"];

	if (isPluginOutput && buildOptions.plugin !== undefined) {
		args.push("--plugin", buildOptions.plugin);
	} else {
		args.push("--output", outputPath);
	}

	if (buildOptions.project !== undefined && buildOptions.project.length > 0) {
		args.push(buildOptions.project);
	}

	if (buildOptions.verbose !== undefined && buildOptions.verbose !== false) {
		const verboseCount = typeof buildOptions.verbose === "number" ? buildOptions.verbose : 1;
		for (let index = 0; index < verboseCount; index++) {
			args.push("--verbose");
		}
	}

	if (buildOptions.watch === true) {
		args.push("--watch");
	}

	if (buildOptions.color !== undefined && buildOptions.color.length > 0) {
		args.push("--color", buildOptions.color);
	}

	return args;
}

function displayBuildInfo(outputPath: string, isPluginOutput: boolean): void {
	log.info(ansis.bold("→ Building project"));

	const outputDisplay = isPluginOutput ? `plugin: ${outputPath}` : outputPath;
	log.step(`Output: ${ansis.cyan(outputDisplay)}`);
}

/**
 * Get the file size of the output file.
 *
 * @param outputPath - Path to the output file.
 * @param isPluginOutput - Whether the output is a plugin.
 * @returns Formatted file size string or empty string.
 */
async function getFileSize(outputPath: string, isPluginOutput: boolean): Promise<string> {
	if (isPluginOutput) {
		return "";
	}

	try {
		const stats = await stat(outputPath);
		const sizeMb = stats.size / (1024 * 1024);
		return sizeMb < 0.1 ? `${(sizeMb * 1024).toFixed(1)} KB` : `${sizeMb.toFixed(1)} MB`;
	} catch {
		return "";
	}
}

function validateOptions(buildOptions: BuildOptions): void {
	const hasOutput = buildOptions.output !== undefined && buildOptions.output.length > 0;
	const hasPlugin = buildOptions.plugin !== undefined && buildOptions.plugin.length > 0;

	if (hasOutput && hasPlugin) {
		log.error("Cannot use both --output and --plugin options together");
		process.exit(1);
	}
}
