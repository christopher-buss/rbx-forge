import type { Environment } from "../seams/seams.ts";
import type { StudioLaunch } from "./launcher.ts";

/**
 * Drop the unset variables, as a native launch takes only strings.
 *
 * @param environment - Variables, some possibly unset.
 * @returns Every variable that has a value.
 */
export function definedOnly(environment: Environment): Record<string, string> {
	const defined: Record<string, string> = {};
	for (const [name, value] of Object.entries(environment)) {
		if (value !== undefined) {
			defined[name] = value;
		}
	}

	return defined;
}

/**
 * Studio's command line: the place, or the session's RunScript task.
 *
 * @param launch - The place and the optional RunScript.
 * @returns The arguments after the executable.
 */
export function studioArguments({
	place,
	runScript,
}: Pick<StudioLaunch, "place" | "runScript">): Array<string> {
	return runScript === undefined
		? [place]
		: ["--task", "RunScript", "--localPlaceFile", place, "--runScriptFile", runScript];
}
