import assert from "node:assert/strict";

import type { CommandContext } from "../commands/context.ts";
import { openPlaceAsync } from "../commands/open.ts";
import { resolveStudioDesktop } from "../config/resolve.ts";
import type { StudioDesktop } from "../config/schema.ts";
import type { StudioReadyListener } from "../seams/network.ts";
import { prepareRojoPluginAsync } from "../studio/rojo-plugin.ts";
import type { PluginCapabilities } from "../studio/rojo-plugin.ts";
import { writeSessionMarkerAsync } from "../studio/session-marker.ts";
import type { OpenedStudio } from "./attach.ts";
import type { PreparedStudio, StudioSetup } from "./studio-part.ts";

interface LaunchOptions {
	defaultDesktop?: StudioDesktop | undefined;
	desktop?: StudioDesktop | undefined;
	signal: AbortSignal;
	studioPath?: string | undefined;
}
type LaunchedStudio = OpenedStudio & {
	plugin: PluginCapabilities;
	readiness?: StudioReadyListener;
};
type LaunchSetup = Pick<StudioSetup, "config" | "directory" | "status">;
const MANUAL: PluginCapabilities = {
	autoConnect: false,
	source: "manual",
	syncAcknowledgement: false,
};

/**
 * Open a marked Studio after validating the listening wrapper's identity.
 *
 * @param setup - The config, directory, and Rojo status.
 * @param steps - The session's steps context.
 * @param options - The Studio path and session signal.
 * @param prepared - Whether the place is already built.
 * @returns The launched Studio and its preparation capabilities.
 * @rejects Identity, preparation, or launch failure; cancellation.
 */
export async function openStudioAsync(
	setup: LaunchSetup,
	steps: CommandContext,
	options: LaunchOptions,
	prepared: Pick<PreparedStudio, "isBuilt">,
): Promise<LaunchedStudio> {
	const { port } = setup.status.snapshot().services.rojo;
	assert(port !== undefined);
	let readiness: StudioReadyListener | undefined;
	try {
		const marker = await writeSessionMarkerAsync(steps, setup.directory, port, {
			readyUrl: async (identity) => {
				readiness = await steps.seams.network.listenForStudioReadyAsync(
					identity,
					options.signal,
				);
				return readiness.url;
			},
			signal: options.signal,
		});
		const opened = await launchMarkedAsync(setup, steps, options, { ...prepared, ...marker });
		if (readiness !== undefined && opened.plugin.syncAcknowledgement) {
			return { ...opened, readiness };
		}

		readiness?.close();
		reportManualStudio(steps);
		return opened;
	} catch (err) {
		readiness?.close();
		throw err;
	}
}

/**
 * Distinguish a place lock from managed synchronization readiness.
 *
 * @param context - Reports the manual connection capability.
 */
function reportManualStudio(context: CommandContext): void {
	context.reporter.emit({
		message:
			"Studio needs a manual Rojo connection; its open status does not confirm synchronization.",
		type: "warning",
	});
}

/**
 * Prepare the plugin only at the launcher's direct-spawn boundary.
 *
 * @param setup - The project config.
 * @param steps - The original environment and preparation seams.
 * @param options - The launch path and cancellation.
 * @param marker - The validated protocol, script, and build state.
 * @returns The Studio and capabilities available for this actual launch.
 * @rejects Preparation, launch failure, or cancellation.
 */
async function launchMarkedAsync(
	{ config }: LaunchSetup,
	steps: CommandContext,
	{ defaultDesktop, desktop, signal, studioPath }: LaunchOptions,
	{
		info,
		isBuilt,
		runScript,
	}: Awaited<ReturnType<typeof writeSessionMarkerAsync>> & Pick<PreparedStudio, "isBuilt">,
): Promise<LaunchedStudio> {
	let plugin = MANUAL;
	const opened = await openPlaceAsync(steps, config, {
		beforeLaunch: async () => {
			signal.throwIfAborted();
			plugin = await prepareRojoPluginAsync(steps, config, info, signal);
			signal.throwIfAborted();
		},
		desktop: resolveStudioDesktop(config, steps.seams.host.platform, defaultDesktop, desktop),
		isBuilt,
		runScript,
		signal,
		studioPath,
	});
	return { ...opened, origin: "forge", plugin: opened.studio === null ? MANUAL : plugin };
}
