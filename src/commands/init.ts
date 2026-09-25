import assert from "node:assert/strict";
import path from "node:path";

import type { FlagDefinition } from "../cli/flags.ts";
import type { ProjectType } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import type { CommandResult } from "../seams/reporter.ts";
import { askAsync } from "./ask.ts";
import type { CommandContext, CommandInput } from "./context.ts";

/** The file `forge init` writes. */
export const CONFIG_FILE_NAME = "rbx-forge.config.ts";

const PROJECT_TYPES: ReadonlyArray<ProjectType> = ["rbxts", "luau"];
const DEFAULT_PROJECT_TYPE: ProjectType = "rbxts";
const ANY_CONFIG_FILE = /^rbx-forge\.config\.\w+$/;

export const INIT_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "type",
		kind: "string",
		text: `Project type. Asks when omitted, or uses ${DEFAULT_PROJECT_TYPE} when it cannot ask.`,
		value: "<rbxts|luau>",
	},
	{ name: "force", kind: "boolean", text: `Replace an existing ${CONFIG_FILE_NAME}.` },
];

/**
 * The content `forge init` writes.
 *
 * @param projectType - The project type to set.
 * @returns A typed `rbx-forge.config.ts`.
 */
export function renderConfigFile(projectType: ProjectType): string {
	return [
		'import { defineConfig } from "rbx-forge";',
		"",
		"export default defineConfig({",
		`\tprojectType: "${projectType}",`,
		"});",
		"",
	].join("\n");
}

/**
 * `forge init`: write `rbx-forge.config.ts` and nothing else.
 *
 * @param context - The run: project directory, seams, and prompting.
 * @param input - The parsed `--type` and `--force` flags.
 * @returns The written path and project type.
 * @rejects {ForgeError} `config_exists` when another config file exists,
 *   `needs_confirmation` or `declined` for an existing file, and `usage` for
 *   a bad `--type`.
 */
export async function runInitAsync(
	context: CommandContext,
	{ flags }: CommandInput,
): Promise<CommandResult> {
	const target = path.join(context.cwd, CONFIG_FILE_NAME);
	const isReplacing = await confirmReplaceAsync(context, flags["force"] === true);
	const projectType =
		flags["type"] === undefined
			? await askProjectTypeAsync(context)
			: projectTypeFromFlag(flags["type"]);

	context.seams.fileSystem.writeFileSync(target, renderConfigFile(projectType));

	return {
		data: { path: target, projectType, replaced: isReplacing },
		summary: `${isReplacing ? "Replaced" : "Created"} ${CONFIG_FILE_NAME} (${projectType}).`,
	};
}

/**
 * Check for existing config files, asking before replacing one.
 *
 * @param context - The run.
 * @param isForced - `--force` was passed.
 * @returns Whether the run replaces an existing `rbx-forge.config.ts`.
 * @rejects {ForgeError} `config_exists`, `needs_confirmation`, or `declined`.
 */
async function confirmReplaceAsync(context: CommandContext, isForced: boolean): Promise<boolean> {
	const existing = context.seams.fileSystem
		.readdirSync(context.cwd)
		.filter((name) => ANY_CONFIG_FILE.test(name));
	const others = existing.filter((name) => name !== CONFIG_FILE_NAME);
	if (others.length > 0) {
		throw new ForgeError(
			"config_exists",
			`${others.join(", ")} already configures this project.`,
			{ hint: `Remove it to let forge init write ${CONFIG_FILE_NAME}.` },
		);
	}

	if (isForced || existing.length === 0) {
		return existing.length > 0;
	}

	const shouldReplace = await askAsync(context, {
		ask: async (prompter) => prompter.confirm(`${CONFIG_FILE_NAME} exists. Replace it?`, false),
		hint: "Pass --force to replace it.",
		text: `${CONFIG_FILE_NAME} already exists.`,
		unattended: undefined,
	});
	if (!shouldReplace) {
		throw new ForgeError("declined", `Kept the existing ${CONFIG_FILE_NAME}.`);
	}

	return true;
}

function toProjectType(value: unknown): ProjectType | undefined {
	return PROJECT_TYPES.find((projectType) => projectType === value);
}

function projectTypeFromFlag(flag: CommandInput["flags"][string]): ProjectType {
	const chosen = toProjectType(flag);
	if (chosen === undefined) {
		throw new ForgeError("usage", `--type must be rbxts or luau, got "${String(flag)}".`, {
			hint: 'Run "forge init --help" for usage.',
		});
	}

	return chosen;
}

async function askProjectTypeAsync(context: CommandContext): Promise<ProjectType> {
	if (!context.interactive) {
		context.reporter.emit({
			message: `No --type given; using ${DEFAULT_PROJECT_TYPE}.`,
			type: "info",
		});
	}

	return askAsync(context, {
		ask: async (prompter) => {
			const typed = await prompter.choose(
				"Project type?",
				PROJECT_TYPES,
				DEFAULT_PROJECT_TYPE,
			);
			const chosen = toProjectType(typed);
			assert(chosen !== undefined, "the prompter answers with one of the choices");
			return chosen;
		},
		hint: "Pass --type.",
		text: "Project type?",
		unattended: DEFAULT_PROJECT_TYPE,
	});
}
