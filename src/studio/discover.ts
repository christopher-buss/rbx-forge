import path from "node:path";

import type { FlagDefinition, FlagValues } from "../cli/flags.ts";
import { withVariables } from "../process/environment.ts";
import type { Environment } from "../seams/seams.ts";

/** The variable that names the Studio executable. */
export const STUDIO_PATH_VARIABLE = "RBX_FORGE_STUDIO_PATH";

/** `--studio-path` of `open`, `start`, and `up`. */
export const STUDIO_PATH_FLAG: FlagDefinition = {
	name: "studio-path",
	kind: "string",
	text: `The Roblox Studio executable to start with the place (over ${STUDIO_PATH_VARIABLE} and the installed Studio).`,
	value: "<path>",
};

/** Where the Studio executable came from. */
export type StudioSource = "application" | "environment" | "flag" | "registry";

/** The Studio executable forge starts directly. */
export interface StudioExecutable {
	path: string;
	source: StudioSource;
}

/**
 * The environment of a session whose `start` or `up` got `--studio-path`:
 * the flag, resolved against the project, goes into
 * {@link STUDIO_PATH_VARIABLE}, so the session's open step finds it first.
 *
 * @param environment - The command's environment.
 * @param cwd - The project root.
 * @param platform - The OS.
 * @param flags - The command's flags.
 * @returns The session's environment.
 */
export function withStudioPath(
	environment: Environment,
	cwd: string,
	platform: NodeJS.Platform,
	flags: FlagValues,
): Environment {
	const studioPath = flags[STUDIO_PATH_FLAG.name];
	return typeof studioPath === "string"
		? withVariables(
				environment,
				{ [STUDIO_PATH_VARIABLE]: path.resolve(cwd, studioPath) },
				platform,
			)
		: environment;
}
