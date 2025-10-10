import type { Config, ResolvedConfig } from "../config/schema";

type CommandName = keyof NonNullable<Config["commandNames"]>;

/**
 * Resolves the configured script name for a command.
 *
 * Used during initialization to generate task runner scripts with custom names.
 * Users can customize these names to match their project conventions while the
 * CLI maintains consistent base command names.
 *
 * @example
 *
 * ```typescript
 * const config = { commandNames: { build: "forge:build" } };
 * getCommandName("build", config); // "forge:build"
 * // Generates: "forge:build": "rbx-forge build"
 *
 * const defaultConfig = {};
 * getCommandName("serve", defaultConfig); // "serve"
 * // Generates: "serve": "rbx-forge serve"
 * ```
 *
 * @param baseName - The base command name (e.g., "build", "serve").
 * @param config - The project configuration.
 * @returns The configured script name for task runner integration.
 */
export function getCommandName(baseName: CommandName, config: ResolvedConfig): string {
	return config.commandNames[baseName];
}
