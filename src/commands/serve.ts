import { getRojoCommand } from "src/utils/rojo";

import { setupSignalHandlers } from "../utils/process-manager";
import { run } from "../utils/run";

export const COMMAND = "serve";
export const DESCRIPTION = "Start the Rojo development server";

export async function action(): Promise<void> {
	setupSignalHandlers();

	const rojo = getRojoCommand();

	await run(rojo, ["serve"], {
		shouldRegisterProcess: true,
		spinnerMessage: "Starting Rojo server...",
	});
}
