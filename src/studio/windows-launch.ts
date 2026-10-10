import { definedOnly, studioArguments } from "./launch-arguments.ts";
import type { StudioLaunch, StudioLaunchBackend } from "./launcher.ts";

/**
 * Windows: start Studio through the addon, out of this process's job.
 *
 * @param backend - The addon.
 * @param launch - The place, directory, and environment.
 * @param executable - The Studio executable.
 * @returns Its PID; `undefined` when breakaway or hidden desktop setup is unavailable.
 */
export function startBreakingAway(
	backend: Pick<StudioLaunchBackend, "native">,
	launch: StudioLaunch,
	executable: string,
): number | undefined {
	const { spawnDetached } = backend.native();
	const { cwd, env } = launch;
	return (
		spawnDetached?.({
			args: studioArguments(launch),
			cwd,
			env: definedOnly(env),
			program: executable,
			...(launch.desktop === undefined ? {} : { desktop: launch.desktop }),
			...(launch.runScript !== undefined && launch.desktop === "hidden"
				? { desktop: "user", hiddenWindows: true }
				: {}),
		}) ?? undefined
	);
}
