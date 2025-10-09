import { cancel, confirm, isCancel, log } from "@clack/prompts";

import ansis from "ansis";
import { detectCodeFormat } from "magicast";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { SCRIPT_NAMES } from "src/commands";
import { loadProjectConfig } from "src/config";
import { getCommandName } from "src/utils/command-names";

interface PackageJson {
	scripts?: Record<string, string>;
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
			initialValue: false,
			message: `Script "${scriptName}" already exists. Overwrite?\n  Current: "${scripts[scriptName]}"`,
		});

		if (isCancel(shouldOverwrite)) {
			cancel("Operation cancelled");
			process.exit(0);
		}

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
		const resolvedCommandName = getCommandName(scriptName, config);
		const scriptCommand = `rbx-forge ${resolvedCommandName}`;
		const result = await addScriptEntry(packageJson, scriptName, scriptCommand);

		if (result === "added") {
			added++;
		} else {
			skipped++;
		}
	}

	return { added, skipped };
}

function getPackageJsonPath(): string {
	return path.join(process.cwd(), "package.json");
}

async function readPackageJson(packageJsonPath: string): Promise<null | PackageJson> {
	try {
		await fs.access(packageJsonPath);
		const content = await fs.readFile(packageJsonPath, "utf8");
		return JSON.parse(content) as PackageJson;
	} catch {
		log.warn(
			ansis.yellow(
				"No package.json found - skipping script installation. Run npm init first.",
			),
		);
		return null;
	}
}

async function writePackageJson(packageJsonPath: string, packageJson: PackageJson): Promise<void> {
	const format = detectCodeFormat(await fs.readFile(packageJsonPath, "utf8"));
	const indentation = format.useTabs === true ? "\t" : " ".repeat(format.tabWidth ?? 2);
	await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, undefined, indentation)}\n`);
}
