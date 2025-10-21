import { isWsl } from "src/utils/is-wsl";

import { run } from "../utils/run";

export const COMMAND = "serve";
export const DESCRIPTION = "Start the Rojo development server";

export async function action(): Promise<void> {
	const rojo = isWsl() ? "rojo.exe" : "rojo";

	await run(rojo, ["serve"], {
		spinnerMessage: "Starting Rojo server...",
	});
}
