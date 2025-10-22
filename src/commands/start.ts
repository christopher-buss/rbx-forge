import { log } from "@clack/prompts";

import ansis from "ansis";

import { loadProjectConfig } from "../config";
import { runScript } from "../utils/run-script";

export const COMMAND = "start";
export const DESCRIPTION = "Compile, build, and open in Roblox Studio";

export async function action(): Promise<void> {
	const config = await loadProjectConfig();

	log.info(ansis.bold("→ Starting full build workflow"));

	await runScript("compile", config);
	await runScript("build", config);
	await runScript("open", config);

	log.success("Workflow complete - project opened in Roblox Studio");
}
