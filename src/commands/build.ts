import { isWsl } from "src/utils/is-wsl";

import { run } from "../utils/run";

export const COMMAND = "build";
export const DESCRIPTION = "Build the Rojo project";

export async function action(): Promise<void> {
	const rojo = isWsl() ? "rojo" : "rojo.exe";

	await run(rojo, ["build", "--output", "game.rbxl"], {
		spinnerMessage: "Building project...",
		successMessage: "Build complete!",
	});
}
