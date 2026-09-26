import type { Environment } from "../seams/seams.ts";

/**
 * The separator between `PATH` entries.
 *
 * @param platform - The OS.
 * @returns `;` on Windows, `:` elsewhere.
 */
export function pathDelimiter(platform: NodeJS.Platform): string {
	return platform === "win32" ? ";" : ":";
}

/**
 * Read an environment variable. Windows names are case-insensitive (`Path`
 * and `PATH` are one variable), and a copied environment loses the case
 * folding `process.env` does there, so Windows lookups ignore case.
 *
 * @param environment - The variables to read from.
 * @param name - Such as `PATH`; case-insensitive on Windows.
 * @param platform - The OS the environment belongs to.
 * @returns The value, or `undefined` when it is not set.
 */
export function readVariable(
	environment: Environment,
	name: string,
	platform: NodeJS.Platform,
): string | undefined {
	return environment[keyOf(environment, name, platform)];
}

/**
 * Copy an environment with some variables set. On Windows a set variable
 * replaces any variable whose name differs only in case.
 *
 * @param environment - The variables to copy.
 * @param values - Variables to set.
 * @param platform - The OS the environment belongs to.
 * @returns The new environment.
 */
export function withVariables(
	environment: Environment,
	values: Readonly<Record<string, string>>,
	platform: NodeJS.Platform,
): Environment {
	const copy = { ...environment };
	for (const [name, value] of Object.entries(values)) {
		copy[keyOf(copy, name, platform)] = value;
	}

	return copy;
}

/**
 * Copy an environment with a directory first on its `PATH`.
 *
 * @param environment - The variables to copy.
 * @param directory - The directory to search first.
 * @param platform - The OS the environment belongs to.
 * @returns The new environment.
 */
export function prependPath(
	environment: Environment,
	directory: string,
	platform: NodeJS.Platform,
): Environment {
	const current = readVariable(environment, "PATH", platform);
	const joined =
		current === undefined || current === ""
			? directory
			: `${directory}${pathDelimiter(platform)}${current}`;
	return withVariables(environment, { PATH: joined }, platform);
}

function keyOf(environment: Environment, name: string, platform: NodeJS.Platform): string {
	if (platform !== "win32") {
		return name;
	}

	const wanted = name.toUpperCase();
	return Object.keys(environment).find((key) => key.toUpperCase() === wanted) ?? name;
}
