import { ForgeError } from "../errors.ts";
import type { Environment, Seams } from "../seams/seams.ts";
import type { StudioProcess } from "./launcher.ts";

/** A snapshot watcher that outlives the command that opens Studio. */
export type SnapshotLightingLauncher = (launch: {
	cwd: string;
	env: Environment;
	place: string;
	studio: StudioProcess;
}) => number;

/**
 * Start the bounded hidden snapshot watcher through the supervisor entry.
 * @param backend - The native detached spawn and current Node executable.
 * @param entry - The supervisor entry script.
 * @returns A launcher independent of the opening CLI's lifetime.
 */
export function createSnapshotLightingLauncher(
	backend: Pick<Seams, "host" | "native">,
	entry: string,
): SnapshotLightingLauncher {
	return ({ cwd, env, place, studio }) => {
		const environment: Record<string, string> = {};
		for (const [key, value] of Object.entries(env)) {
			if (value !== undefined) {
				environment[key] = value;
			}
		}

		const pid = backend.native().spawnDetached?.({
			args: [
				entry,
				"--watch-hidden-lighting",
				JSON.stringify({ pid: studio.pid, place, startTime: studio.startTime }),
			],
			cwd,
			env: environment,
			program: backend.host.execPath,
		});
		if (pid === undefined || pid === null) {
			throw new ForgeError(
				"studio_launch_failed",
				"The hidden snapshot Lighting watcher could not start.",
			);
		}

		return pid;
	};
}
