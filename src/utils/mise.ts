import { cancel, confirm, isCancel, log } from "@clack/prompts";

import ansis from "ansis";
import { type } from "arktype";
import process from "node:process";

import { COMMANDS, SCRIPT_NAMES } from "../commands";
import { loadProjectConfig } from "../config";
import type { ResolvedConfig } from "../config/schema";
import { getCommandName } from "./command-names";
import { run, runOutput } from "./run";

interface MiseTask {
	description: string;
	name: string;
	run: Array<string>;
	source: string;
}

const miseTasksArraySchema = type([
	{
		description: "string",
		name: "string",
		run: "string[]",
		source: "string",
	},
	"[]",
]);

export async function checkMiseInstallation(): Promise<boolean> {
	try {
		await runOutput("mise", ["version"]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Adds rbx-forge tasks to mise using the mise CLI. Exits with code 2 if mise is
 * not installed.
 *
 * @returns Success message.
 */
export async function updateMiseToml(): Promise<string> {
	const isMiseInstalled = await checkMiseInstallation();
	if (!isMiseInstalled) {
		cancel(ansis.yellow("⚠ mise not found - please install mise to continue"));
		process.exit(2);
	}

	const config = await loadProjectConfig();
	const existingTasks = await getExistingMiseTasks();
	const scriptableCommands = COMMANDS.filter((cmd) => {
		return SCRIPT_NAMES.includes(cmd.COMMAND as (typeof SCRIPT_NAMES)[number]);
	});

	const { added, skipped } = await addMiseTasks(scriptableCommands, existingTasks, config);

	if (added === 0) {
		return "";
	}

	const message = `Added ${added} task(s) to ${ansis.magenta("mise.toml")}`;
	return skipped > 0 ? `${message} (${skipped} skipped)` : message;
}

async function addMiseTask(
	miseTaskName: string,
	commandName: string,
	description: string,
): Promise<void> {
	await run(
		"mise",
		["task", "add", miseTaskName, "--description", description, "--", "rbx-forge", commandName],
		{
			shouldShowCommand: false,
			shouldStreamOutput: false,
		},
	);
}

async function addMiseTasks(
	commands: ReadonlyArray<(typeof COMMANDS)[number]>,
	existingTasks: Map<string, MiseTask>,
	config: ResolvedConfig,
): Promise<{ added: number; skipped: number }> {
	let added = 0;
	let skipped = 0;

	for (const cmd of commands) {
		const taskName = cmd.COMMAND;
		const resolvedScriptName = getCommandName(taskName, config);
		const description = cmd.DESCRIPTION;

		const existingTask = existingTasks.get(resolvedScriptName);
		if (existingTask) {
			const shouldOverwrite = await confirmTaskOverwrite(existingTask);
			if (shouldOverwrite) {
				await addMiseTask(resolvedScriptName, taskName, description);
				added++;
			} else {
				skipped++;
			}
		} else {
			await addMiseTask(resolvedScriptName, taskName, description);
			added++;
		}
	}

	return { added, skipped };
}

async function confirmTaskOverwrite(existingTask: MiseTask): Promise<boolean> {
	const currentCommand = existingTask.run.join(" ");

	log.message(`Current task: ${ansis.cyan(currentCommand)}`);

	const shouldOverwrite = await confirm({
		initialValue: false,
		message: `Task "${existingTask.name}" already exists. Overwrite?`,
	});

	if (isCancel(shouldOverwrite)) {
		cancel("Operation cancelled");
		process.exit(0);
	}

	return shouldOverwrite;
}

/**
 * Gets existing mise tasks by parsing `mise tasks ls --json`.
 *
 * @returns Map of task names to their details.
 */
async function getExistingMiseTasks(): Promise<Map<string, MiseTask>> {
	try {
		const output = await runOutput("mise", ["tasks", "ls", "--json"]);
		const parsed = JSON.parse(output);
		const validated = miseTasksArraySchema(parsed);

		if (validated instanceof type.errors) {
			return new Map();
		}

		return new Map(validated.map((task) => [task.name, task]));
	} catch {
		return new Map();
	}
}
