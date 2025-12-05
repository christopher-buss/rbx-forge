import { confirm } from "@inquirer/prompts";

import ansis from "ansis";
import { detectCodeFormat } from "magicast";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { SCRIPT_NAMES } from "src/commands";
import { loadProjectConfig } from "src/config";
import { CLI_COMMAND } from "src/constants";
import { getCommandName } from "src/utils/command-names";

import { logger } from "./logger";

export interface PackageJson {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
}

export function getPackageJsonPath(): string {
	return path.join(process.cwd(), "package.json");
}

export async function readPackageJson(packageJsonPath: string): Promise<null | PackageJson> {
	try {
		await fs.access(packageJsonPath);
		return (await Bun.file(packageJsonPath).json()) as PackageJson;
	} catch {
		logger.warn(
			ansis.yellow(
				"No package.json found - skipping script installation. Run npm init first.",
			),
		);
		return null;
	}
}

/**
 * Updates the package.json file with rbx-forge scripts.
 *
 * @returns Success message or empty string if package.json doesn't exist.
 */
export async function updatePackageJson(): Promise<string> {
	const packageJsonPath = getPackageJsonPath();
	const packageJson = await readPackageJson(packageJsonPath);

	if (!packageJson) {
		return "";
	}

	const config = await loadProjectConfig();
	const { added, skipped } = await addScriptsToPackageJson(packageJson, config);
	await writePackageJson(packageJsonPath, packageJson);

	if (added === 0) {
		return "";
	}

	const message = `Added ${added} script(s) to ${ansis.magenta("package.json")}`;
	return skipped > 0 ? `${message} (${skipped} skipped)` : message;
}

export async function writePackageJson(
	packageJsonPath: string,
	packageJson: PackageJson,
): Promise<void> {
	const bunFile = Bun.file(packageJsonPath);
	const format = detectCodeFormat(await bunFile.text());
	const indentation = format.useTabs === true ? "\t" : " ".repeat(format.tabWidth ?? 2);
	await bunFile.write(`${JSON.stringify(packageJson, undefined, indentation)}\n`);
}

async function addScriptEntry(
	packageJson: PackageJson,
	scriptName: string,
	scriptCommand: string,
): Promise<"added" | "skipped"> {
	const { scripts } = packageJson;
	if (!scripts) {
		return "skipped";
	}

	if (scripts[scriptName] !== undefined) {
		const shouldOverwrite = await confirm({
			default: false,
			message: `Script "${scriptName}" already exists. Overwrite?\n  Current: "${scripts[scriptName]}"`,
		});

		if (shouldOverwrite) {
			scripts[scriptName] = scriptCommand;
			return "added";
		}

		return "skipped";
	}

	scripts[scriptName] = scriptCommand;
	return "added";
}

async function addScriptsToPackageJson(
	packageJson: PackageJson,
	config: Awaited<ReturnType<typeof loadProjectConfig>>,
): Promise<{ added: number; skipped: number }> {
	packageJson.scripts ??= {};

	let added = 0;
	let skipped = 0;

	for (const scriptName of SCRIPT_NAMES) {
		const resolvedScriptName = getCommandName(scriptName, config);
		const scriptCommand = `${CLI_COMMAND} ${scriptName}`;
		const result = await addScriptEntry(packageJson, resolvedScriptName, scriptCommand);

		if (result === "added") {
			added++;
		} else {
			skipped++;
		}
	}

	return { added, skipped };
}
