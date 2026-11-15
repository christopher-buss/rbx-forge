import type { StudioDesktop } from "../config/schema.ts";
import type { Environment } from "../seams/seams.ts";
import type { PinnedStudio } from "../seams/studio-host.ts";

/** One place to open in Roblox Studio. */
export interface StudioLaunch {
	/**
	 * Prepare a session plugin after discovery, immediately before direct
	 * launch.
	 */
	beforeLaunch?: (() => Promise<void>) | undefined;
	cwd: string;
	desktop?: StudioDesktop | undefined;
	env: Environment;
	/** The absolute path of the place file. */
	place: string;
	/** A session marker script, run after Studio opens the place. */
	runScript?: string | undefined;
	/** The `--studio-path` flag: the Studio executable to start. */
	studioPath?: string | undefined;
	/** Start a detached watcher for a snapshot's delayed migration prompt. */
	watchHiddenLighting?: boolean | undefined;
}

/** A Studio forge started itself, pinned at the start. */
export interface StudioProcess {
	desktop?: StudioDesktop;
	pid: number;
	/** Its OS start time (see `processStartTime`). */
	startTime: string;
}

/** A verified Studio process with its current placement. */
export type LocatedStudio = StudioProcess & { desktop: StudioDesktop };

/**
 * Whether Studio got the place. `studio`: the Studio forge started
 * directly; absent when the platform launcher opened the place. `hint`:
 * what the user can do, when forge knows better than the default.
 */
export type StudioLaunchOutcome =
	| { desktop?: StudioDesktop; studio?: StudioProcess; type: "launched"; warning?: string }
	| { hint?: string | undefined; message: string; studio?: never; type: "failed" };

/**
 * Opens a place in Roblox Studio, so Studio is never a child of forge and
 * never in a process group or job that forge ends. With a Studio executable
 * found, forge starts it directly with the place, optionally using RunScript;
 * else the platform launcher opens the place. Rejects with `native_missing`
 * when Windows has no addon.
 */
export type StudioLauncher = (launch: StudioLaunch) => Promise<StudioLaunchOutcome>;

/**
 * Read a verified Studio's identity and placement from its pin.
 *
 * @param pinned - A process verified as Studio.
 * @returns Its process identity and placement.
 */
export async function studioProcessAsync(pinned: PinnedStudio): Promise<LocatedStudio> {
	const desktop = await pinned.desktopAsync();
	return {
		desktop:
			desktop === "hidden" ? desktop : ((await pinned.windowVisibilityAsync()) ?? desktop),
		pid: pinned.pid,
		startTime: pinned.startTime,
	};
}
