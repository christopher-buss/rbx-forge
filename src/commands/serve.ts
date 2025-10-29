import { getRojoCommand } from "src/utils/rojo";

import { loadProjectConfig } from "../config";
import { setupSignalHandlers } from "../utils/process-manager";
import { run } from "../utils/run";

export const COMMAND = "serve";
export const DESCRIPTION = "Start the Rojo development server";

export const options = [
	{
		description: "Path to the project to serve (defaults to current directory)",
		flags: "--project <path>",
	},
] as const;

export interface ServeOptions {
	project?: string;
}

export async function action(commandOptions: ServeOptions = {}): Promise<void> {
	setupSignalHandlers();

	const config = await loadProjectConfig();
	const rojo = getRojoCommand();

	const args = ["serve"];

	const projectPath = commandOptions.project ?? config.rojoProjectPath;
	if (projectPath.length > 0) {
		args.push(projectPath);
	}

	await run(rojo, args, {
		shouldRegisterProcess: true,
		spinnerMessage: "Starting Rojo server...",
	});
}
