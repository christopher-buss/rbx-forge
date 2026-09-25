import type { Type } from "arktype";
import { type } from "arktype";

import { ForgeError } from "../errors.ts";

/** What the project compiles from. */
export type ProjectType = "luau" | "rbxts";

/** Commands that run config hooks. */
export type HookCommand = "build" | "compile" | "open" | "syncback" | "typegen";

/** Shell commands to run before and after one forge command. */
export interface HookPhases {
	/** Run after the command succeeds, in order. Not run when it fails. */
	post?: Array<string>;
	/** Run before the command, in order. A failure aborts the command. */
	pre?: Array<string>;
}

/** The roblox-ts compiler (`projectType: "rbxts"`). */
export interface RbxtsOptions {
	/** Arguments for every compiler run. Watch mode adds `-w`. */
	args?: Array<string>;
	/** The compiler command. */
	command?: string;
}

/** The watch command of a Luau project (for example darklua). */
export interface LuauWatchOptions {
	args?: Array<string>;
	/** No command means a Luau session runs no compiler. */
	command?: string;
}

/** Options for Luau projects (`projectType: "luau"`). */
export interface LuauOptions {
	watch?: LuauWatchOptions;
}

/** Options for `forge open`. */
export interface OpenOptions {
	/** Build the place before opening it. */
	buildFirst?: boolean;
	/** The place to open. Falls back to `buildOutputPath`. */
	buildOutputPath?: string;
	/** The Rojo project to build. Falls back to `rojoProjectPath`. */
	projectPath?: string;
}

/** Options for syncback (Studio edits back into the project). */
export interface SyncbackOptions {
	/** The place file syncback reads. Falls back to `buildOutputPath`. */
	inputPath?: string;
	/** The Rojo project syncback writes. Falls back to `rojoProjectPath`. */
	projectPath?: string;
	/** Run syncback on every place save during `forge start` and `forge up`. */
	runOnStart?: boolean;
}

/** Options for `forge typegen`. */
export interface TypegenOptions {
	/** Instance path globs to leave out. */
	exclude?: Array<string>;
	/** Instance path globs to keep. */
	include?: Array<string>;
	/** Deepest instance level to type. No value means no limit. */
	maxDepth?: number;
	/** The generated declaration file. */
	outputPath?: string;
}

/**
 * The `rbx-forge.config.ts` file. Every key except `projectType` is optional;
 * unknown keys are errors.
 */
export interface ForgeConfig {
	/** The place or model file `forge build` writes. */
	buildOutputPath?: string;
	/** How long workers get to stop after a graceful stop request. */
	gracefulTimeoutMs?: number;
	/** Shell commands around forge commands, keyed by command. */
	hooks?: Partial<Record<HookCommand, HookPhases>>;
	luau?: LuauOptions;
	open?: OpenOptions;
	projectType: ProjectType;
	rbxts?: RbxtsOptions;
	/** The Rojo command, for example a fork with syncback support. */
	rojoAlias?: string;
	/** The fixed port of `rojo serve`. A busy port is an error. */
	rojoPort?: number;
	/** The Rojo project file. */
	rojoProjectPath?: string;
	syncback?: SyncbackOptions;
	typegen?: TypegenOptions;
}

/**
 * One layer of config before defaults: the file's content, or the values the
 * flags set. Every key is optional.
 */
export type ConfigLayer = Partial<ForgeConfig>;

const STRINGS = "string[]";
const PATH = "string > 0";

const hookPhases = type({
	"+": "reject",
	"post?": STRINGS,
	"pre?": STRINGS,
});

const fileSchema = type({
	"+": "reject",
	"buildOutputPath?": PATH,
	"gracefulTimeoutMs?": "number.integer >= 0",
	"hooks?": {
		"+": "reject",
		"build?": hookPhases,
		"compile?": hookPhases,
		"open?": hookPhases,
		"syncback?": hookPhases,
		"typegen?": hookPhases,
	},
	"luau?": {
		"+": "reject",
		"watch?": { "+": "reject", "args?": STRINGS, "command?": PATH },
	},
	"open?": {
		"+": "reject",
		"buildFirst?": "boolean",
		"buildOutputPath?": PATH,
		"projectPath?": PATH,
	},
	"projectType": "'luau' | 'rbxts'",
	"rbxts?": { "+": "reject", "args?": STRINGS, "command?": PATH },
	"rojoAlias?": PATH,
	"rojoPort?": "1 <= number.integer <= 65535",
	"rojoProjectPath?": PATH,
	"syncback?": {
		"+": "reject",
		"inputPath?": PATH,
		"projectPath?": PATH,
		"runOnStart?": "boolean",
	},
	"typegen?": {
		"+": "reject",
		"exclude?": STRINGS,
		"include?": STRINGS,
		"maxDepth?": "number.integer >= 1",
		"outputPath?": PATH,
	},
});

/** The schema of a config file; the annotation checks it against the type. */
const configFileSchema: Type<ForgeConfig> = fileSchema;
/** The same rules for a partial layer, such as the values flags set. */
const configLayerSchema: Type<ConfigLayer> = fileSchema.partial();

/**
 * Keys an earlier forge accepted, with what to do instead. Checked before the
 * schema so the error says why, not only "must be removed".
 */
const REMOVED_KEYS: ReadonlyArray<readonly [path: string, instead: string]> = [
	["commandNames", "forge no longer writes task-runner scripts. Use `hooks`."],
	["rbxts.watchOnOpen", "`forge start` always runs the compiler in watch mode."],
	["suppressNoTaskRunnerWarning", "forge no longer uses a task runner."],
	["syncbackInputPath", "Use `syncback.inputPath`."],
	["typegenOutputPath", "Use `typegen.outputPath`."],
];

/**
 * Validate the content of a config file.
 *
 * @param value - What the file exported.
 * @param file - The file's path, for the error message.
 * @returns The value, typed.
 * @throws {ForgeError} `config_removed_key` for a removed key, or
 *   `config_invalid` for anything else the schema rejects.
 */
export function validateConfigFile(value: unknown, file: string): ForgeConfig {
	rejectRemovedKeys(value, file);
	return check(configFileSchema, value, (summary) => {
		return new ForgeError("config_invalid", `Invalid config in ${file}:\n${summary}`, {
			hint: "Fix or remove the keys named above.",
		});
	});
}

/**
 * Validate a partial layer of config, such as the values flags set.
 *
 * @param value - The values to check.
 * @param describe - Makes the error for a schema failure.
 * @returns The same values, typed as a config layer.
 */
export function validateConfigLayer(
	value: unknown,
	describe: (summary: string) => ForgeError,
): ConfigLayer {
	return check(configLayerSchema, value, describe);
}

function check<T>(
	schema: Type<T>,
	value: unknown,
	describe: (summary: string) => ForgeError,
): Type<T>["infer"] {
	const result = schema(value);
	if (result instanceof type.errors) {
		throw describe(result.summary);
	}

	return result;
}

function hasPath(value: unknown, keys: ReadonlyArray<string>): boolean {
	let current = value;
	for (const key of keys) {
		if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) {
			return false;
		}

		const next: unknown = Reflect.get(current, key);
		current = next;
	}

	return true;
}

function rejectRemovedKeys(value: unknown, file: string): void {
	for (const [path, instead] of REMOVED_KEYS) {
		if (hasPath(value, path.split("."))) {
			throw new ForgeError(
				"config_removed_key",
				`${file}: \`${path}\` was removed. ${instead}`,
				{ hint: `Remove \`${path}\` from the config file.` },
			);
		}
	}
}
