import { cancel, log } from "@clack/prompts";

import ansis from "ansis";
import { scope, type } from "arktype";
import process from "node:process";

import { isWsl } from "./is-wsl";
import { runOutput } from "./run";

export interface RojoSourceMap {
	children?: ReadonlyArray<RojoSourceMap>;
	// eslint-disable-next-line unicorn/no-keyword-prefix -- Matches Rojo sourcemap output format
	className: string;
	name: string;
}

const types = scope({
	RojoSourceMap: {
		"children?": "RojoSourceMap[]",
		"className": "string",
		"name": "string",
	},
});

const rojoSourceMapSchema = types.type("RojoSourceMap");

export async function checkRojoInstallation(): Promise<string> {
	try {
		const rojoVersion = await runOutput("rojo", ["--version"]);
		return `Found Rojo ${ansis.cyan(rojoVersion)}`;
	} catch {
		cancel(ansis.yellow("⚠ Rojo not found - please install Rojo to use this tool"));
		process.exit(2);
	}
}

/**
 * Get the correct rojo executable name for the current platform.
 *
 * WSL (Windows Subsystem for Linux) needs to call the Windows executable (.exe)
 * to properly interact with the Windows filesystem and processes.
 *
 * @returns `rojo.exe` on WSL, `rojo` on other platforms.
 */
export function getRojoCommand(): string {
	return isWsl() ? "rojo.exe" : "rojo";
}

/**
 * Executes `rojo sourcemap` and returns the parsed JSON output.
 *
 * @param rojoProjectPath - Optional path to a specific Rojo project file.
 * @returns The parsed Rojo source map.
 */
export async function getRojoSourceMap(rojoProjectPath?: string): Promise<RojoSourceMap> {
	const rojo = getRojoCommand();
	const args = ["sourcemap"];

	if (rojoProjectPath !== undefined && rojoProjectPath.length > 0) {
		args.push(rojoProjectPath);
	}

	try {
		const output = await runOutput(rojo, args);
		const parsed = JSON.parse(output);
		return validateSourceMap(parsed);
	} catch (err) {
		const errorMessage =
			err instanceof Error ? err.message : "Failed to execute rojo sourcemap";
		log.error(errorMessage);

		throw err;
	}
}

/**
 * Validates parsed JSON data against the Rojo sourcemap schema.
 *
 * @param parsed - The parsed JSON data to validate.
 * @returns The validated Rojo source map.
 */
function validateSourceMap(parsed: unknown): RojoSourceMap {
	const validated = rojoSourceMapSchema(parsed);

	if (validated instanceof type.errors) {
		log.error("Invalid Rojo sourcemap format:");
		log.error(validated.summary);

		throw new Error(`Invalid Rojo sourcemap format: ${validated.summary}`);
	}

	return validated;
}
