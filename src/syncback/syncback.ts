import path from "node:path";

import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import type { HookedRun } from "../hooks/run-hooks.ts";
import { runWithHooksAsync } from "../hooks/run-hooks.ts";
import { requireSyncbackAsync, rojoSyncbackArgs, runRojoAsync } from "../rojo/rojo.ts";

/** What syncback reads and writes, relative to the project root. */
export interface SyncbackTarget {
	/** The place file to read. */
	input: string;
	/** The Rojo project whose files syncback writes. */
	project: string;
}

/** What one syncback did. */
export interface SyncbackOutcome {
	durationMs: number;
	/** The absolute path of the place file it read. */
	input: string;
	/** The Rojo project file, as configured. */
	project: string;
}

/** The config {@link syncbackAsync} reads. */
export type SyncbackConfig = Pick<ResolvedConfig, "hooks" | "hookTimeoutMs" | "rojoAlias">;

/**
 * Where syncback reads and writes: the `syncback` options, falling back to the
 * build output and the Rojo project.
 *
 * @param config - The resolved config.
 * @returns The place to read and the project to write.
 */
export function resolveSyncbackTarget(
	config: Pick<ResolvedConfig, "buildOutputPath" | "rojoProjectPath" | "syncback">,
): SyncbackTarget {
	return {
		input: config.syncback.inputPath ?? config.buildOutputPath,
		project: config.syncback.projectPath ?? config.rojoProjectPath,
	};
}

/**
 * One syncback with its `syncback` hooks: write the place's instances back
 * into the project's files. `forge syncback` runs it, and so do the session's
 * save watcher and `forge sync`.
 *
 * Rojo's syncback support is checked first, so a Rojo without it fails before
 * any hook runs.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param config - The Rojo command and the hooks.
 * @param target - The place to read and the project to write.
 * @returns The syncback outcome and every hook result.
 * @rejects `rojo_missing`, `syncback_unsupported`,
 *   `process_failed` (with Rojo's output), `hook_failed`, or
 *   `hook_depth_exceeded`.
 */
export async function syncbackAsync(
	context: CommandContext,
	config: SyncbackConfig,
	target: SyncbackTarget,
): Promise<HookedRun<SyncbackOutcome>> {
	await requireSyncbackAsync(context, config);
	return runWithHooksAsync(context, config, "syncback", async () => {
		const args = rojoSyncbackArgs(target.project, target.input);
		const { durationMs } = await runRojoAsync(context, config, args);
		return {
			durationMs,
			input: path.resolve(context.cwd, target.input),
			project: target.project,
		};
	});
}
