import path from "node:path";

import type { CommandContext } from "../commands/context.ts";
import { readVariable } from "../process/environment.ts";

/**
 * Studio's local Plugins folder.
 *
 * @param context - The environment and host.
 * @returns The folder; `undefined` with no home or on an OS without Studio.
 */
export function studioPluginsFolder({
	env,
	seams,
}: Pick<CommandContext, "env" | "seams">): string | undefined {
	const { platform } = seams.host;
	const home = readVariable(env, platform === "win32" ? "USERPROFILE" : "HOME", platform);
	if (home === undefined || home === "") {
		return undefined;
	}

	if (platform === "win32") {
		return path.join(home, "AppData", "Local", "Roblox", "Plugins");
	}

	return platform === "darwin" ? path.join(home, "Documents", "Roblox", "Plugins") : undefined;
}
