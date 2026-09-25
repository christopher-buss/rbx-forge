import { ForgeError } from "../errors.ts";
import type { ConfigLoader } from "../seams/config-loader.ts";
import type { ResolvedConfig } from "./resolve.ts";
import { resolveConfig } from "./resolve.ts";
import type { ConfigLayer } from "./schema.ts";
import { validateConfigFile } from "./schema.ts";

/** A project's resolved config and where it came from. */
export interface ProjectConfig {
	config: ResolvedConfig;
	/** Absolute path of the config file. */
	path: string;
}

/**
 * Load, validate, and resolve the project's config.
 *
 * @param cwd - The project directory.
 * @param configLoader - Finds and evaluates the config file.
 * @param flags - Config values the flags set; they win over the file.
 * @returns The resolved config and the file's path.
 * @rejects {ForgeError} `config_not_found`, `config_load_failed`, or
 *   `config_invalid`.
 */
export async function loadProjectConfigAsync(
	cwd: string,
	configLoader: ConfigLoader,
	flags: ConfigLayer,
): Promise<ProjectConfig> {
	let file;
	try {
		file = await configLoader(cwd);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new ForgeError("config_load_failed", `Could not load the config file: ${reason}`, {
			cause: err,
		});
	}

	if (file === undefined) {
		throw new ForgeError("config_not_found", `No rbx-forge config file in ${cwd}.`, {
			hint: "Run `forge init` to create rbx-forge.config.ts.",
		});
	}

	return {
		config: resolveConfig(validateConfigFile(file.value, file.path), flags),
		path: file.path,
	};
}
