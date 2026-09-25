import type { ConfigLayer, ForgeConfig, HookCommand, HookPhases, ProjectType } from "./schema.ts";

/**
 * Every config value that has a default. Keys with no default stay
 * `undefined` until a layer sets them.
 */
export interface ConfigDefaults {
	buildOutputPath: string;
	gracefulTimeoutMs: number;
	hooks: Partial<Record<HookCommand, HookPhases>>;
	luau: { watch: { args: Array<string>; command: string | undefined } };
	open: {
		buildFirst: boolean;
		buildOutputPath: string | undefined;
		projectPath: string | undefined;
	};
	rbxts: { args: Array<string>; command: string };
	rojoAlias: string;
	rojoPort: number;
	rojoProjectPath: string;
	syncback: {
		inputPath: string | undefined;
		projectPath: string | undefined;
		runOnStart: boolean;
	};
	typegen: {
		exclude: Array<string>;
		include: Array<string>;
		maxDepth: number | undefined;
		outputPath: string;
	};
}

/** The config every command reads: flags over the file over the defaults. */
export interface ResolvedConfig extends ConfigDefaults {
	projectType: ProjectType;
}

/** Every default. `projectType` has none: the config file must set it. */
export const DEFAULT_CONFIG: Readonly<ConfigDefaults> = {
	buildOutputPath: "game.rbxl",
	gracefulTimeoutMs: 3000,
	hooks: {},
	luau: { watch: { args: [], command: undefined } },
	open: { buildFirst: true, buildOutputPath: undefined, projectPath: undefined },
	rbxts: { args: [], command: "rbxtsc" },
	rojoAlias: "rojo",
	rojoPort: 34_872,
	rojoProjectPath: "default.project.json",
	syncback: { inputPath: undefined, projectPath: undefined, runOnStart: false },
	typegen: {
		exclude: ["**/node_modules/**"],
		include: ["**"],
		maxDepth: undefined,
		outputPath: "src/services.d.ts",
	},
};

/**
 * Resolve the config: flags over the file over {@link DEFAULT_CONFIG}. This is
 * the one place defaults apply. Objects merge key by key; every other value,
 * arrays included, replaces the value below it (the schema rejects an explicit
 * `undefined`, so no layer can unset a value).
 *
 * @param file - The validated config file.
 * @param flags - The config values the flags set.
 * @returns The resolved config.
 */
export function resolveConfig(file: ForgeConfig, flags: ConfigLayer): ResolvedConfig {
	// A copy, so a caller that changes its config never changes the defaults.
	const merged = [file, flags].reduce<Record<string, unknown>>(
		mergeLayer,
		structuredClone(DEFAULT_CONFIG),
	);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The file sets `projectType`, both layers passed the schema, and the defaults fill every other key.
	return merged as unknown as ResolvedConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	// The schema rejects `null`, and the defaults hold none.
	return typeof value === "object" && !Array.isArray(value);
}

function mergeLayer(base: Record<string, unknown>, layer: object): Record<string, unknown> {
	const merged = { ...base };
	for (const [key, value] of Object.entries(layer)) {
		const below = merged[key];
		merged[key] = isRecord(value) && isRecord(below) ? mergeLayer(below, value) : value;
	}

	return merged;
}
