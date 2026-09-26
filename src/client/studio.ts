import path from "node:path";

import type { FlagDefinition } from "../cli/flags.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import type { Environment } from "../seams/seams.ts";
import type { RecoveryOptions } from "../studio/close-studio.ts";
import type { ForgeFiles } from "../supervisor/session-files.ts";

/** `--recovery` of `stop` and `down`. */
export const RECOVERY_FLAG: FlagDefinition = {
	name: "recovery",
	config: "studio.autoRecovery",
	kind: "string",
	text: "What to do with the auto-recovery files of a Studio forge ends: move (to .forge/recovery), delete, or keep.",
	value: "<mode>",
};

/**
 * The auto-recovery options of a project.
 *
 * @param environment - Holds the AutoSaves folder locations.
 * @param forge - The project's `.forge` files.
 * @param config - Holds `studio.autoRecovery`, with `--recovery` over it.
 * @returns The mode, the environment, and the recovery folder.
 */
export function recoveryOptions(
	environment: Environment,
	forge: ForgeFiles,
	config: Pick<ResolvedConfig, "studio">,
): RecoveryOptions {
	return {
		env: environment,
		mode: config.studio.autoRecovery,
		recoveryDirectory: path.join(forge.directory, "recovery"),
	};
}
