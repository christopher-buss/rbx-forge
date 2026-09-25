import type { UserInputConfig } from "c12";
import { loadConfig } from "c12";

/** A config file found in the project, before validation. */
export interface ConfigFile {
	/** Absolute path of the file. */
	path: string;
	/** The file's default export (or parsed content), not yet validated. */
	value: unknown;
}

/**
 * Find and evaluate the `rbx-forge.config.*` file of the project in `cwd`.
 * Resolves `undefined` when there is no file, and rejects when a file exists
 * but cannot be evaluated. Validation is not its job (`config/load.ts`).
 */
export type ConfigLoader = (cwd: string) => Promise<ConfigFile | undefined>;

/**
 * The real {@link ConfigLoader}: c12 with only file discovery on. No rc files,
 * no package.json key, no dotenv, no environment layers, no `extends`, and no
 * defaults, so c12 never merges (its `defu` merge concatenates arrays).
 * Defaults are applied once, in `config/resolve.ts`.
 *
 * @param cwd - Project directory to search.
 * @returns The file, or `undefined` when there is none.
 */
export async function loadConfigFileAsync(cwd: string): Promise<ConfigFile | undefined> {
	const result = await loadConfig({
		name: "rbx-forge",
		cwd,
		dotenv: false,
		envName: false,
		extend: false,
		globalRc: false,
		merger: pickMainLayer,
		omit$Keys: true,
		packageJson: false,
		rcFile: false,
	});

	return result._configFile === undefined
		? undefined
		: { path: result._configFile, value: result.config };
}

/**
 * Only the main file is ever present, so hand it through unmerged.
 *
 * @param sources - The layers c12 would merge.
 * @returns The first present layer.
 */
function pickMainLayer(...sources: Array<null | undefined | UserInputConfig>): UserInputConfig {
	return sources.find((source) => source !== undefined && source !== null) ?? {};
}
