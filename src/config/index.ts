import type { Config } from "./schema";

export { createProjectConfig as updateProjectConfig } from "./create";
export { loadProjectConfig } from "./loader";

/**
 * Define a typed configuration for rbxts-forge.
 *
 * @example
 *
 * ```typescript
 * import { defineConfig } from "rbxts-forge";
 *
 * export default defineConfig({
 * 	buildOutputPath: "build/game.rbxl",
 * });
 * ```
 *
 * @param config - The configuration object.
 * @returns The same configuration object with type checking.
 */
export function defineConfig(config: Config): Config {
	return config;
}
