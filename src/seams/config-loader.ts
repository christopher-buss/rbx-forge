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
 * The real {@link ConfigLoader}: c12 with only file discovery on. No rc file,
 * no environment layers, no `extends`, and no defaults. Package.json keys,
 * global rc files, and dotenv are off by default. With one layer, c12's `defu`
 * merge (which concatenates arrays) has nothing to merge; defaults are
 * applied once, in `config/resolve.ts`.
 *
 * @param cwd - Project directory to search.
 * @returns The file, or `undefined` when there is none.
 */
export async function loadConfigFileAsync(cwd: string): Promise<ConfigFile | undefined> {
	const result = await loadConfig({
		name: "rbx-forge",
		cwd,
		envName: false,
		extend: false,
		omit$Keys: true,
		rcFile: false,
	});

	return result._configFile === undefined
		? undefined
		: { path: result._configFile, value: result.config };
}
