import { log } from "@clack/prompts";

import ansis from "ansis";

import type { ScriptName } from "../commands";
import type { ResolvedConfig } from "../config/schema";
import { getCommandName } from "./command-names";
import { detectAvailableTaskRunner, getCallingTaskRunner } from "./detect-task-runner";
import { run } from "./run";

/**
 * Runs a script via the appropriate task runner.
 *
 * This function enables command chaining while respecting the calling context.
 * If the current process was invoked via npm/mise, subsequent commands will use
 * the same task runner. This ensures consistency and allows users to hook into
 * commands by customizing scripts in package.json or .mise.toml.
 *
 * Priority order:
 *
 * 1. Use the task runner that invoked the current process (context-aware)
 * 2. Auto-detect available task runners (mise > npm)
 * 3. Fallback to direct CLI invocation.
 *
 * @example Implementing a start command that chains build → serve
 *
 * ```typescript
 * // src/commands/start.ts
 * import { loadProjectConfig } from "../config";
 * import { runScript } from "../utils/run-script";
 *
 * export async function action(): Promise<void> {
 * 	const config = await loadProjectConfig();
 *
 * 	// Build the project first
 * 	await runScript("build", config);
 *
 * 	// Then start the dev server
 * 	await runScript("serve", config);
 * }
 *
 * // If user customized their scripts:
 * // package.json: "forge:build": "npm run typecheck && rbx-forge build"
 * // The typecheck will run before building, respecting user hooks!
 * ```
 *
 * @param scriptName - The base script name to run (e.g., "build", "serve").
 * @param config - The project configuration.
 */
export async function runScript(scriptName: ScriptName, config: ResolvedConfig): Promise<void> {
	const resolvedName = getCommandName(scriptName, config);

	const callingRunner = getCallingTaskRunner();

	if (callingRunner === "mise") {
		await run("mise", ["run", resolvedName], {
			shouldShowCommand: false,
		});
		return;
	}

	if (callingRunner === "npm") {
		await run("npm", ["run", resolvedName, "--silent"], {
			shouldShowCommand: false,
		});
		return;
	}

	const available = await detectAvailableTaskRunner();

	if (available === "mise") {
		await run("mise", ["run", resolvedName]);
	} else if (available === "npm") {
		await run("npm", ["run", resolvedName, "--silent"]);
	} else {
		log.warn(
			ansis.yellow(
				"⚠ No task runner detected - running command directly. This may skip user-defined hooks.",
			),
		);
		await run("rbx-forge", [scriptName]);
	}
}
