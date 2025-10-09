import { cancel, confirm, isCancel, log } from "@clack/prompts";

import ansis from "ansis";
import process from "node:process";

import { COMMANDS, SCRIPT_NAMES } from "../commands";
import { run, runOutput } from "./run";

interface MiseTask {
	description: string;
	name: string;
	run: Array<string>;
	source: string;
}

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

	const existingTasks = await getExistingMiseTasks();
	const scriptableCommands = COMMANDS.filter((cmd) => SCRIPT_NAMES.includes(cmd.COMMAND));

	const { added, skipped } = await addMiseTasks(scriptableCommands, existingTasks);

	if (added === 0) {
		return "";
	}

	const message = `Added ${added} task(s) to ${ansis.magenta("mise.toml")}`;
	return skipped > 0 ? `${message} (${skipped} skipped)` : message;
}

async function addMiseTask(taskName: string, description: string): Promise<void> {
	await run(
		"mise",
		["task", "add", taskName, "--description", description, "--", "rbx-forge", taskName],
		{
			shouldShowCommand: false,
			shouldStreamOutput: false,
		},
	);
}

async function addMiseTasks(
	commands: ReadonlyArray<(typeof COMMANDS)[number]>,
	existingTasks: Map<string, MiseTask>,
): Promise<{ added: number; skipped: number }> {
	let added = 0;
	let skipped = 0;

	for (const cmd of commands) {
		const taskName = cmd.COMMAND;
		const description = cmd.DESCRIPTION;

		const existingTask = existingTasks.get(taskName);
		if (existingTask) {
			const shouldOverwrite = await confirmTaskOverwrite(existingTask);
			if (shouldOverwrite) {
				await addMiseTask(taskName, description);
				added++;
			} else {
				skipped++;
			}
		} else {
			await addMiseTask(taskName, description);
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
		const tasks = JSON.parse(output) as unknown as Array<MiseTask>;
		return new Map(tasks.map((task) => [task.name, task]));
	} catch {
		return new Map();
	}
}
