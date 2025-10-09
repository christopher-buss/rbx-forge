import {
	cancel,
	intro,
	isCancel,
	log,
	multiselect,
	note,
	outro,
	select,
	tasks,
} from "@clack/prompts";

import ansis from "ansis";
import process from "node:process";
import type { Config } from "src/config/schema";
import { updateMiseToml } from "src/utils/mise";
import { updatePackageJson } from "src/utils/package-json";

import { updateProjectConfig } from "../config";
import { run, runOutput } from "../utils/run";

export const COMMAND = "init";
export const DESCRIPTION = "Initialize a new rbx-forge project";

type TaskRunner = "lune" | "mise" | "npm";

export async function action(): Promise<void> {
	if (process.env["NODE_ENV"] === "development") {
		void run("rm", ["-rf", "rbx-forge.config.ts"], {
			shouldShowCommand: false,
		});
	}

	intro(ansis.bold("🔨 rbx-forge init"));

	const { projectType, taskRunners } = await getUserInput();

	await runInitializationTasks(projectType, taskRunners);
	showNextSteps(taskRunners);
	outro(ansis.green("✨ You're all set!"));
}

async function checkRojoInstallation(): Promise<string> {
	try {
		const rojoVersion = await runOutput("rojo", ["--version"]);
		return `Found Rojo ${ansis.cyan(rojoVersion)}`;
	} catch {
		cancel(ansis.yellow("⚠ Rojo not found - please install Rojo to use this tool"));
		process.exit(2);
	}
}

async function createForgeConfig(projectType: "luau" | "rbxts"): Promise<string> {
	await updateProjectConfig(projectType);
	return `Config file created at ${ansis.magenta("rbx-forge.config.ts")}`;
}

async function createRojoProject(): Promise<string> {
	try {
		await run("rojo", ["init"], {
			shouldShowCommand: false,
			shouldStreamOutput: false,
		});
	} catch {
		log.message(ansis.gray("Rojo project structure already exists, skipping"));
		return "";
	}

	return "Project structure created";
}

async function getUserInput(): Promise<{
	projectType: Config["projectType"];
	taskRunners: Array<TaskRunner>;
}> {
	const projectType = await select({
		message: "Pick a project type.",
		options: [
			{ label: "TypeScript", value: "rbxts" },
			{ label: "Luau", value: "luau" },
		],
	});

	if (isCancel(projectType)) {
		cancel("Operation cancelled");
		process.exit(0);
	}

	const taskRunners = await multiselect({
		message: "Pick a task runner (optional).",
		options: [
			{ hint: "default", label: "npm", value: "npm" },
			{ label: "mise", value: "mise" },
			{ disabled: true, hint: "coming soon", label: "lune", value: "lune" },
		],
		required: false,
	});

	if (isCancel(taskRunners)) {
		cancel("Operation cancelled");
		process.exit(0);
	}

	return { projectType, taskRunners };
}

async function runInitializationTasks(
	projectType: "luau" | "rbxts",
	taskRunners: Array<"lune" | "mise" | "npm">,
): Promise<void> {
	const initTasks = [
		{ task: checkRojoInstallation, title: "Checking Rojo installation" },
		{ task: createRojoProject, title: "Creating Rojo project structure" },
		{
			task: async () => createForgeConfig(projectType),
			title: "Creating rbx-forge config",
		},
	];

	// Add npm scripts task if npm is selected
	if (taskRunners.includes("npm")) {
		initTasks.push({
			task: async () => updatePackageJson(),
			title: "Adding npm scripts to package.json",
		});
	}

	// Add mise tasks if mise is selected
	if (taskRunners.includes("mise")) {
		initTasks.push({
			task: async () => updateMiseToml(),
			title: "Adding mise tasks to .mise.toml",
		});
	}

	await tasks(initTasks);
}

function showNextSteps(taskRunners: Array<"lune" | "mise" | "npm">): void {
	const shouldUseMise = taskRunners.includes("mise");
	const shouldUseNpm = taskRunners.includes("npm");

	const buildName = "forge:build";
	const serveName = "forge:serve";

	let buildCommand = `rbx-forge ${buildName}`;
	let serveCommand = `rbx-forge ${serveName}`;

	if (shouldUseMise) {
		buildCommand = "mise run forge.build";
		serveCommand = "mise run forge.serve";
	} else if (shouldUseNpm) {
		buildCommand = "npm run build";
		serveCommand = "npm run serve";
	}

	note(
		"Next steps:\n\n" +
			`  1. Run ${ansis.cyan("npm install")} to install dependencies\n` +
			`  2. Run ${ansis.cyan(buildCommand)} to build your project\n` +
			`  3. Run ${ansis.cyan(serveCommand)} to start development`,
		"Next Steps",
	);
}
