import { loadProjectConfig } from "../config";
import { isWsl } from "../utils/is-wsl";
import { run } from "../utils/run";

export const COMMAND = "build";
export const DESCRIPTION = "Build the Rojo project";

export async function action(): Promise<void> {
	const config = await loadProjectConfig();
	const rojo = isWsl() ? "rojo" : "rojo.exe";

	await run(rojo, ["build", "--output", config.buildOutputPath ?? "game.rbxl"], {
		spinnerMessage: "Building project...",
		successMessage: "Build complete!",
	});
}
