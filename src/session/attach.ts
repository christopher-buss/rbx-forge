import path from "node:path";

import type { CommandContext } from "../commands/context.ts";
import { openPlacePath } from "../commands/open.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { findPlaceStudio } from "../studio/close-studio.ts";
import type { StudioProcess } from "../studio/launcher.ts";

/** The place the session opened, and the Studio it started or attached. */
export interface OpenedStudio {
	/** The absolute path of the place. */
	place: string;
	/** `null` when the platform launcher opened the place. */
	studio: null | StudioProcess;
}

/**
 * Find the verified Studio that already has the session's place open: the
 * session uses it, and opens no second one.
 *
 * @param context - The project root, seams, and reporter.
 * @param config - The resolved config: the place the session opens.
 * @returns The place and that Studio, or `undefined` when there is none.
 */
export function attachStudio(
	context: CommandContext,
	config: Pick<ResolvedConfig, "buildOutputPath" | "open">,
): OpenedStudio | undefined {
	const place = path.resolve(context.cwd, openPlacePath(config));
	const studio = findPlaceStudio(context.seams, place);
	if (studio === undefined) {
		return undefined;
	}

	context.reporter.emit({
		message: `Roblox Studio (PID ${studio.pid}) already has ${place} open, so the session uses it.`,
		type: "info",
	});
	return { place, studio };
}
