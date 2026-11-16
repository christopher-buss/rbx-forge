import { ForgeError } from "../../errors.ts";
import { definedOnly } from "../../studio/launch-arguments.ts";
import type { StudioProcess } from "../../studio/launcher.ts";
import type { Environment, Seams } from "../seams.ts";

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
	backend: Pick<Seams, "childProcess" | "host" | "native">,
	entry: string,
): SnapshotLightingLauncher {
	return ({ cwd, env, place, studio }) => {
		const environment = definedOnly(env);

		const args = [
			entry,
			"--watch-hidden-lighting",
			JSON.stringify({ pid: studio.pid, place, startTime: studio.startTime }),
		];
		if (backend.host.platform === "linux") {
			return spawnLinux(backend, args, cwd, environment);
		}

		const pid = backend.native().spawnDetached?.({
			args,
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

function ignoreError(): void {
	// The snapshot is already open; an asynchronous spawn failure is best effort.
}

function spawnLinux(
	backend: Pick<Seams, "childProcess" | "host">,
	args: Array<string>,
	cwd: string,
	environment: Record<string, string>,
): number {
	const child = backend.childProcess.spawn(backend.host.execPath, args, {
		cwd,
		detached: true,
		env: environment,
		stdio: "ignore",
		windowsHide: true,
	});
	child.once("error", ignoreError);
	if (child.pid === undefined) {
		throw new ForgeError(
			"studio_launch_failed",
			"The hidden snapshot Lighting watcher could not start.",
		);
	}

	child.unref();
	return child.pid;
}
