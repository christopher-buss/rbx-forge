import { log } from "@clack/prompts";

import { run, runOutput } from "../utils/run";

export const COMMAND = "init";
export const DESCRIPTION = "Initialize a new rbxts-forge project";

export async function action(): Promise<void> {
	log.info("Initializing new project...");

	try {
		const rojoVersion = await runOutput("rojo", ["--version"]);
		log.info(`Using Rojo ${rojoVersion}`);
	} catch {
		log.warn("Rojo not found - please install Rojo to use this tool");
	}

	await run("rojo", ["init"], {
		spinnerMessage: "Creating project files...",
		successMessage: "Project initialized!",
	});
}
