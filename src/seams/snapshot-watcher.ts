import type { StudioLaunch, StudioLaunchOutcome } from "../studio/launcher.ts";
import type { SnapshotLightingLauncher } from "./addon-studio/snapshot-lighting-launcher.ts";

export function watchSnapshotLighting(
	watch: SnapshotLightingLauncher | undefined,
	launch: StudioLaunch,
	outcome: StudioLaunchOutcome,
): StudioLaunchOutcome {
	if (launch.watchHiddenLighting !== true || outcome.studio?.desktop !== "hidden") {
		return outcome;
	}

	try {
		watch?.({ cwd: launch.cwd, env: launch.env, place: launch.place, studio: outcome.studio });
		return outcome;
	} catch (err) {
		return {
			...outcome,
			type: "launched",
			warning: `Studio opened, but its automatic Lighting prompt watcher could not start: ${String(err)}`,
		};
	}
}
