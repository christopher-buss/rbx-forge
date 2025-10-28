import { log } from "@clack/prompts";

import ansis from "ansis";

import { runScript } from "../utils/run";

export const COMMAND = "restart";
export const DESCRIPTION = "Stop Roblox Studio and restart the workflow";

export async function action(): Promise<void> {
	log.info(ansis.bold("→ Restarting workflow"));

	await runScript("stop");
	await runScript("start");
}
