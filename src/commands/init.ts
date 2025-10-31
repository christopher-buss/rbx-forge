import {
	cancel,
	confirm,
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
import { detect } from "package-manager-detector";
import type { ResolvedConfig } from "src/config/schema";
import { updateMiseToml } from "src/utils/mise";
import {
	getPackageJsonPath,
	readPackageJson,
	updatePackageJson,
	writePackageJson,
} from "src/utils/package-json";
import { checkRojoInstallation } from "src/utils/rojo";

import { name as packageName, version as packageVersion } from "../../package.json";
import { loadProjectConfig, updateProjectConfig } from "../config";
import { getCommandName } from "../utils/command-names";
import { findCommandForPackageManager, run } from "../utils/run";

export const COMMAND = "init";
export const DESCRIPTION = `Initialize a new ${packageName} project`;

const OPERATION_CANCELLED = "Operation cancelled";

type TaskRunner = "lune" | "mise" | "npm";

export async function action(): Promise<void> {
	intro(ansis.bold(`🔨 ${packageName} init`));

	const { projectType, taskRunners } = await getUserInput();

	await runInitializationTasks(projectType, taskRunners);
	await showNextSteps(taskRunners);
	outro(ansis.green("✨ You're all set!"));
}

async function addRbxForgeToPackageJson(): Promise<void> {
	const packageJsonPath = getPackageJsonPath();
	const packageJson = await readPackageJson(packageJsonPath);

	if (!packageJson) {
		return;
	}

	// Check if already installed
	const hasInDeps = packageJson.dependencies?.[packageName] !== undefined;
	const hasInDevelopmentDeps = packageJson.devDependencies?.[packageName] !== undefined;

	if (hasInDeps || hasInDevelopmentDeps) {
		return;
	}

	const shouldAddRbxForge = await confirm({
		initialValue: true,
		message: `Add ${packageName} to devDependencies? (recommended)`,
	});

	if (isCancel(shouldAddRbxForge)) {
		cancel(OPERATION_CANCELLED);
		process.exit(0);
	}

	if (shouldAddRbxForge) {
		packageJson.devDependencies ??= {};
		packageJson.devDependencies[packageName] = `^${packageVersion}`;
		await writePackageJson(packageJsonPath, packageJson);
		log.success(
			`Added ${packageName}@^${packageVersion} to ${ansis.magenta("devDependencies")}`,
		);
	}
}

async function createForgeConfig(projectType: "luau" | "rbxts"): Promise<string> {
	await updateProjectConfig(projectType);
	const configFileName = `${packageName}.config.ts`;
	return `Config file created at ${ansis.magenta(configFileName)}`;
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

async function getInstallCommand(shouldUseMise: boolean, shouldUseNpm: boolean): Promise<string> {
	if (shouldUseMise) {
		return "mise install";
	}

	if (shouldUseNpm) {
		const { args, command } = await findCommandForPackageManager("install");
		return `${command} ${args.join(" ")}`;
	}

	throw new Error("This should not be called if no task runner is used.");
}

async function getTaskRunnerCommand(
	scriptName: string,
	shouldUseMise: boolean,
	shouldUseNpm: boolean,
): Promise<string> {
	if (shouldUseMise) {
		return `mise run ${scriptName}`;
	}

	if (shouldUseNpm) {
		const { args, command } = await findCommandForPackageManager("run", [scriptName]);
		return `${command} ${args.join(" ")}`;
	}

	// Extract base command name (e.g., "forge:build" -> "build")
	const baseCommand = scriptName.replace(/^forge:/, "");
	return `${packageName} ${baseCommand}`;
}

async function getUserInput(): Promise<{
	projectType: ResolvedConfig["projectType"];
	taskRunners: Array<TaskRunner>;
}> {
	const projectType = await selectProjectType();

	const taskRunners = await selectTaskRunners();

	return { projectType, taskRunners };
}

async function runInitializationTasks(
	projectType: "luau" | "rbxts",
	taskRunners: Array<TaskRunner>,
): Promise<void> {
	const initTasks = [
		{ task: checkRojoInstallation, title: "Checking Rojo installation" },
		{ task: createRojoProject, title: "Creating Rojo project structure" },
		{
			task: async () => createForgeConfig(projectType),
			title: `Creating ${packageName} config`,
		},
	];

	if (taskRunners.includes("npm")) {
		// Add package to package.json if not already present
		await addRbxForgeToPackageJson();

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

async function selectProjectType(): Promise<ResolvedConfig["projectType"]> {
	const projectType = await select({
		message: "Pick a project type.",
		options: [
			{ label: "TypeScript", value: "rbxts" },
			{ label: "Luau", value: "luau" },
		],
	});

	if (isCancel(projectType)) {
		cancel(OPERATION_CANCELLED);
		process.exit(0);
	}

	return projectType;
}

async function selectTaskRunners(): Promise<Array<TaskRunner>> {
	const { agent } = (await detect()) ?? { agent: "npm" };

	const taskRunners = await multiselect({
		message: "Pick task runner(s) (optional).",
		options: [
			{ hint: "default", label: agent, value: "npm" },
			{ label: "mise", value: "mise" },
			{ disabled: true, hint: "coming soon", label: "lune", value: "lune" },
		],
		required: false,
	});

	if (isCancel(taskRunners)) {
		cancel(OPERATION_CANCELLED);
		process.exit(0);
	}

	return taskRunners;
}

async function showNextSteps(taskRunners: Array<TaskRunner>): Promise<void> {
	const shouldUseMise = taskRunners.includes("mise");
	const shouldUseNpm = taskRunners.includes("npm");

	const config = await loadProjectConfig();
	const buildScriptName = getCommandName("build", config);
	const serveScriptName = getCommandName("serve", config);

	const buildCommand = await getTaskRunnerCommand(buildScriptName, shouldUseMise, shouldUseNpm);
	const serveCommand = await getTaskRunnerCommand(serveScriptName, shouldUseMise, shouldUseNpm);

	const steps: Array<string> = [];
	let step = 1;

	function addStep(stepDescription: string): void {
		steps.push(`  ${step}. ${stepDescription}`);
		step++;
	}

	if (shouldUseMise || shouldUseNpm) {
		const installCommand = await getInstallCommand(shouldUseMise, shouldUseNpm);
		addStep(`Run ${ansis.cyan(installCommand)} to install dependencies`);
	}

	addStep(`Run ${ansis.cyan(buildCommand)} to build your project`);
	addStep(`Run ${ansis.cyan(serveCommand)} to start development`);

	note(`Next steps:\n\n${steps.join("\n")}`, "Next Steps");
}
