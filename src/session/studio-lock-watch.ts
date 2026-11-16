import type { CommandContext } from "../commands/context.ts";
import { studioLockPath } from "../studio/lock-file.ts";
import type { OpenedStudio } from "./attach.ts";
import type { StudioLockWatch } from "./watch.ts";

/**
 * The lock file of the place, and the Studio it must name while that
 * Studio runs.
 *
 * @param context - Reads process start times.
 * @param opened - The place and its Studio.
 * @returns The lock watch.
 */
export function studioLock(
	context: CommandContext,
	{ place, studio }: OpenedStudio,
): StudioLockWatch {
	return {
		isAlive: async () => {
			try {
				return (
					studio === null ||
					(await context.seams.studioHost.processStartTimeAsync(studio.pid)) ===
						studio.startTime
				);
			} catch (err) {
				// Unavailable Windows control proves no Studio exit.
				if (context.seams.studioHost.onControl !== undefined) {
					return true;
				}

				throw err;
			}
		},
		path: studioLockPath(place),
		pid: studio?.pid,
	};
}
