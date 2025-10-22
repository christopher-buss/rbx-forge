import { log } from "@clack/prompts";

import ansis from "ansis";
import { runScript } from "src/utils/run";

import { loadProjectConfig } from "../config";

export const COMMAND = "start";
export const DESCRIPTION = "Compile, build, and open in Roblox Studio";

export async function action(): Promise<void> {
	const config = await loadProjectConfig();

	log.info(ansis.bold("→ Starting full build workflow"));

	await runScript("compile", config);
	await runScript("build", config);
	await runScript("open", config);
}
