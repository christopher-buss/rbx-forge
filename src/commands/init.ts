import { checkbox, confirm, select } from "@inquirer/prompts";

import ansis from "ansis";
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
import { logger } from "../utils/logger";
import { findCommandForPackageManager } from "../utils/run";

export const COMMAND = "init";
export const DESCRIPTION = `Initialize a new ${packageName} project`;

type TaskRunner = "lune" | "mise" | "npm";

export async function action(): Promise<void> {
	console.log();
	logger.info(ansis.bold(`${packageName} init`));

	const { projectType, taskRunners } = await getUserInput();

	await runInitializationTasks(projectType, taskRunners);
	await showNextSteps(taskRunners);

	logger.success("You're all set!");
	console.log();
}

async function addRbxForgeToPackageJson(): Promise<void> {
	const packageJsonPath = getPackageJsonPath();
	const packageJson = await readPackageJson(packageJsonPath);

	if (!packageJson) {
		return;
	}

	const hasInDeps = packageJson.dependencies?.[packageName] !== undefined;
	const hasInDevelopmentDeps = packageJson.devDependencies?.[packageName] !== undefined;

	if (hasInDeps || hasInDevelopmentDeps) {
		return;
	}

	const shouldAddRbxForge = await confirm({
		default: true,
		message: `Add ${packageName} to devDependencies? (recommended)`,
	});

	if (shouldAddRbxForge) {
		packageJson.devDependencies ??= {};
		packageJson.devDependencies[packageName] = `^${packageVersion}`;
		await writePackageJson(packageJsonPath, packageJson);
		logger.success(
			`Added ${packageName}@^${packageVersion} to ${ansis.magenta("devDependencies")}`,
		);
	}
}

async function createForgeConfig(projectType: "luau" | "rbxts"): Promise<void> {
	await updateProjectConfig(projectType);
	const configFileName = `${packageName}.config.ts`;
	logger.success(`Config file created at ${ansis.magenta(configFileName)}`);
}

async function createRojoProject(): Promise<void> {
	try {
		await Bun.$`rojo init`.quiet();
		logger.success("Project structure created");
	} catch {
		logger.message(ansis.gray("Rojo project structure already exists, skipping"));
	}
}

async function getInstallCommand(shouldUseMise: boolean, shouldUseNpm: boolean): Promise<string> {
	if (shouldUseMise) {
		return "mise install";
	}

	if (shouldUseNpm) {
		const { name } = (await detect()) ?? { agent: "npm" };
		try {
			const { args, command } = await findCommandForPackageManager("install", [], name);
			return `${command} ${args.join(" ")}`;
		} catch {
			return "npm install";
		}
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
		const { name } = (await detect()) ?? { agent: "npm" };
		try {
			const { args, command } = await findCommandForPackageManager("run", [scriptName], name);
			return `${command} ${args.join(" ")}`;
		} catch {
			return `npm run ${scriptName}`;
		}
	}

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
	logger.info("Running initialization tasks...");

	await checkRojoInstallation();
	await createRojoProject();
	await createForgeConfig(projectType);

	if (taskRunners.includes("npm")) {
		await addRbxForgeToPackageJson();
		await updatePackageJson();
		logger.success("Added npm scripts to package.json");
	}

	if (taskRunners.includes("mise")) {
		await updateMiseToml();
		logger.success("Added mise tasks to .mise.toml");
	}
}

async function selectProjectType(): Promise<ResolvedConfig["projectType"]> {
	return select({
		choices: [
			{ name: "TypeScript", value: "rbxts" as const },
			{ name: "Luau", value: "luau" as const },
		],
		message: "Pick a project type.",
	});
}

async function selectTaskRunners(): Promise<Array<TaskRunner>> {
	const { agent } = (await detect()) ?? { agent: "npm" };

	return checkbox({
		choices: [
			{ name: agent, value: "npm" as const },
			{ name: "mise", value: "mise" as const },
			{ disabled: "(coming soon)", name: "lune", value: "lune" as const },
		],
		message: "Pick task runner(s) (optional).",
	});
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

	console.log();
	logger.info("Next steps:");
	for (const value of steps) {
		console.log(value);
	}
}
