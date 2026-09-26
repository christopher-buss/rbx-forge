import type { ForgeConfig } from "./schema.ts";

/**
 * Type the default export of `rbx-forge.config.ts`. Returns its argument
 * unchanged; forge validates the file when it loads it.
 *
 * @example
 *
 * ```ts
 * import { defineConfig } from "rbx-forge";
 *
 * export default defineConfig({ projectType: "rbxts" });
 * ```
 *
 * @param config - The project's config.
 * @returns The same object.
 */
export function defineConfig(config: ForgeConfig): ForgeConfig {
	return config;
}
