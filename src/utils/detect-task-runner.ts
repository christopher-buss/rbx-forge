import path from "node:path";
import process from "node:process";

export type AvailableTaskRunner = "mise" | "none" | "npm";
export type TaskRunner = "mise" | "npm" | null;

/**
 * Detects available task runners by checking for mise tasks or npm scripts.
 *
 * Checks for task runner availability in priority order (mise > npm). For mise,
 * checks if project-level tasks are configured. For npm, checks if package.json
 * has scripts defined.
 *
 * This is used as a fallback when no calling context is detected (i.e., when
 * rbx-forge is invoked directly rather than through a task runner script).
 *
 * @example
 *
 * ```typescript
 * // Project has mise tasks configured locally
 * await detectAvailableTaskRunner(); // "mise" (higher priority)
 *
 * // Project only has package.json with scripts
 * await detectAvailableTaskRunner(); // "npm"
 *
 * // Project has no task runner configuration
 * await detectAvailableTaskRunner(); // "none"
 * ```
 *
 * @returns The first available task runner, or "none" if neither is available.
 */
export async function detectAvailableTaskRunner(): Promise<AvailableTaskRunner> {
	const cwd = process.cwd();

	if (await hasMiseTasks()) {
		return "mise";
	}

	try {
		const packageJsonPath = path.join(cwd, "package.json");
		const packageJson = (await Bun.file(packageJsonPath).json()) as {
			scripts?: Record<string, string>;
		};

		if (packageJson.scripts && Object.keys(packageJson.scripts).length > 0) {
			return "npm";
		}
	} catch {}

	return "none";
}

/**
 * Detects which task runner invoked the current process.
 *
 * Checks environment variables set by npm/pnpm/yarn/mise to determine the
 * calling context. This ensures command chaining uses the same task runner that
 * initiated the process, providing consistent behavior and respecting user
 * customizations.
 *
 * Environment variables checked:
 *
 * - `npm_lifecycle_event`: Set by npm/pnpm/yarn when running scripts
 * - `MISE_TASK_NAME`: Set by mise when running tasks.
 *
 * @example
 *
 * ```typescript
 * // User runs: npm run forge:build
 * getCallingTaskRunner(); // "npm"
 *
 * // User runs: mise run forge:build
 * getCallingTaskRunner(); // "mise"
 *
 * // User runs: rbx-forge build (directly)
 * getCallingTaskRunner(); // null
 * ```
 *
 * @returns The detected task runner ("mise", "npm") or null if called directly.
 */
export function getCallingTaskRunner(): TaskRunner {
	if (Bun.env["MISE_TASK_NAME"] !== undefined) {
		return "mise";
	}

	if (Bun.env["npm_lifecycle_event"] !== undefined) {
		return "npm";
	}

	return null;
}

/**
 * Checks if mise has project-level tasks configured. Uses --local flag to
 * explicitly check for project tasks only.
 *
 * @returns True if mise has local tasks, false otherwise.
 */
async function hasMiseTasks(): Promise<boolean> {
	try {
		const result = await Bun.$`mise tasks ls --local`.quiet().nothrow();
		return result.exitCode === 0 && result.stdout.toString().trim().length > 0;
	} catch {
		return false;
	}
}
