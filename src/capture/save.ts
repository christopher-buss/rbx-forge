import path from "node:path";

import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError, toForgeError } from "../errors.ts";
import { rojoBuildArgs, runRojoAsync } from "../rojo/rojo.ts";
import type { StudioSave } from "../studio/save-studio.ts";
import type { Capture, CaptureListener, CaptureWarning } from "./protocol.ts";
import { withCaptureWarnings } from "./warnings.ts";

/** One Studio and its bounded capture request. */
export interface CaptureSaveOptions {
	deadline: number;
	listener: CaptureListener;
	signal: AbortSignal;
	studio: { desktop?: "hidden" | "user"; pid?: number; place: string };
}

/**
 * Build the current syncback base and atomically replace it with Studio's capture.
 * @param context - The project, tools and native assembly seam.
 * @param config - The syncback project and destination.
 * @param options - The listener, Studio identity, deadline and cancellation.
 * @returns The written place metadata.
 * @rejects A build, capture, cancellation, or assembly failure with any received warnings.
 */
export async function saveCaptureAsync(
	context: CommandContext,
	config: ResolvedConfig,
	{ deadline, listener, signal, studio }: CaptureSaveOptions,
): Promise<StudioSave> {
	const started = context.seams.clock.now();
	const output = path.resolve(context.cwd, config.syncback.inputPath ?? studio.place);
	const base = path.join(path.dirname(output), `.forge-capture-${context.seams.randomId()}.rbxl`);
	let warnings: Array<CaptureWarning> = [];
	try {
		signal.throwIfAborted();
		await runRojoAsync(
			boundedContext(context, deadline),
			config,
			rojoBuildArgs(config.syncback.projectPath ?? config.rojoProjectPath, {
				output: base,
				type: "output",
			}),
		);
		signal.throwIfAborted();
		const capture = await listener.captureAsync(signal);
		warnings = capture.warnings ?? [];
		signal.throwIfAborted();
		assembleCapture(context, { base, capture, output });
		return {
			...captureResult(context, studio, output, started),
			warnings,
		};
	} catch (err) {
		throw withCaptureWarnings(err, warnings);
	} finally {
		context.seams.fileSystem.rmSync(base, { force: true });
	}
}

function assembleCapture(
	{ seams }: CommandContext,
	{ base, capture, output }: { base: string; capture: Capture; output: string },
): void {
	try {
		seams.native().assemblePlace(base, capture.model, JSON.stringify(capture.services), output);
	} catch (err) {
		throw new ForgeError(
			"capture_assembly_failed",
			`Could not assemble the captured place ${output}.`,
			{ cause: err, details: { message: toForgeError(err).message } },
		);
	}
}

function boundedContext(context: CommandContext, deadline: number): CommandContext {
	const { seams } = context;
	return {
		...context,
		seams: {
			...seams,
			processRunner: async (spec) => {
				const outcome = await seams.processRunner({
					...spec,
					timeoutMs: Math.max(1, deadline - seams.clock.now()),
				});
				if (outcome.type === "timed_out") {
					throw new ForgeError(
						"capture_timeout",
						"The capture base did not build before the timeout.",
					);
				}

				return outcome;
			},
		},
	};
}

function captureResult(
	{ seams }: CommandContext,
	studio: CaptureSaveOptions["studio"],
	output: string,
	started: number,
): StudioSave {
	const stat = seams.fileSystem.statSync(output);
	return {
		bytes: stat.size,
		desktop: studio.desktop ?? "user",
		durationMs: seams.clock.now() - started,
		mtime: stat.mtime.toISOString(),
		pid: studio.pid ?? 0,
		place: output,
	};
}
