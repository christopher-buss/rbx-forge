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

import { updateProjectConfig } from "../config";
import { run, runOutput } from "../utils/run";
import { updatePackageJson } from "../utils/update-package-json";

export const COMMAND = "init";
export const DESCRIPTION = "Initialize a new rbxts-forge project";

type TaskRunner = "lune" | "mise" | "npm";

export async function action(): Promise<void> {
	if (process.env["NODE_ENV"] === "development") {
		void run("rm", ["-rf", "rbxts-forge.config.ts"], {
			shouldShowCommand: false,
		});
	}

	intro(ansis.bold("🔨 rbxts-forge init"));

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
	return `Config file created at ${ansis.magenta("rbxts-forge.config.ts")}`;
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
		message: "Pick a task runner.",
		options: [
			{ hint: "default", label: "npm", value: "npm" },
			{ label: "mise", value: "mise" },
			{ disabled: true, hint: "coming soon", label: "lune", value: "lune" },
		],
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
			title: "Creating rbxts-forge config",
		},
	];

	// Add npm scripts task if npm is selected
	if (taskRunners.includes("npm")) {
		initTasks.push({
			task: async () => updatePackageJson(),
			title: "Adding npm scripts to package.json",
		});
	}

	await tasks(initTasks);
}

function showNextSteps(taskRunners: Array<"lune" | "mise" | "npm">): void {
	const shouldUseNpmScripts = taskRunners.includes("npm");

	const buildCommand = shouldUseNpmScripts ? "npm run build" : "rbxts-forge build";
	const serveCommand = shouldUseNpmScripts ? "npm run serve" : "rbxts-forge serve";

	note(
		"Next steps:\n\n" +
			`  1. Run ${ansis.cyan("npm install")} to install dependencies\n` +
			`  2. Run ${ansis.cyan(buildCommand)} to build your project\n` +
			`  3. Run ${ansis.cyan(serveCommand)} to start development`,
		"Next Steps",
	);
}
