import ansis from "ansis";

import { logger } from "../utils/logger";
import { runScript } from "../utils/run";

export const COMMAND = "restart";
export const DESCRIPTION = "Stop Roblox Studio and restart the workflow";

export async function action(): Promise<void> {
	logger.info(ansis.bold("→ Restarting workflow"));

	await runScript("stop");
	await runScript("start");
}
