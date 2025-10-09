import type { Config } from "../config/schema";

type CommandName = keyof NonNullable<Config["commandNames"]>;

/**
 * Resolves the effective command name from config.
 *
 * Returns the custom command name from config if defined, otherwise returns the
 * base command name as-is.
 *
 * @example
 *
 * ```typescript
 * const config = { commandNames: { build: "forge:build" } };
 * getCommandName("build", config); // "forge:build"
 * getCommandName("serve", {}); // "serve"
 * ```
 *
 * @param baseName - The base command name (e.g., "build", "serve").
 * @param config - The project configuration.
 * @returns The effective command name to use.
 */
export function getCommandName(baseName: CommandName, config: Config): string {
	return config.commandNames?.[baseName] ?? baseName;
}
