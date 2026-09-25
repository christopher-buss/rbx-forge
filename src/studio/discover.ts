import path from "node:path";

import type { FlagDefinition, FlagValues } from "../cli/flags.ts";
import { ForgeError } from "../errors.ts";
import { readVariable, withVariables } from "../process/environment.ts";
import type { FileSystem } from "../seams/file-system.ts";
import type { Host } from "../seams/host.ts";
import type { Environment, Seams } from "../seams/seams.ts";

/** The variable that names the Studio executable. */
export const STUDIO_PATH_VARIABLE = "RBX_FORGE_STUDIO_PATH";

/**
 * Registry keys (under `HKEY_CURRENT_USER`) whose default value is the
 * command that opens Studio, best first: the `roblox-studio:` link handler,
 * then the `.rbxl` file type. Both run `"<exe>" %1`.
 */
export const STUDIO_REGISTRY_KEYS: ReadonlyArray<string> = [
	String.raw`Software\Classes\roblox-studio\shell\open\command`,
	String.raw`Software\Classes\Roblox.Place\shell\open\command`,
];

/** `--studio-path` of `open`, `start`, and `up`. */
export const STUDIO_PATH_FLAG: FlagDefinition = {
	name: "studio-path",
	kind: "string",
	text: `The Roblox Studio executable to start with the place (over ${STUDIO_PATH_VARIABLE} and the installed Studio).`,
	value: "<path>",
};

/** Where the Roblox installer puts Studio on macOS. */
export const MACOS_STUDIO_PATH = "/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio";

/** Where the Studio executable came from. */
export type StudioSource = "application" | "environment" | "flag" | "registry";

/** The Studio executable forge starts directly. */
export interface StudioExecutable {
	path: string;
	source: StudioSource;
}

/** The seams that find Studio. */
export interface DiscoverySeams {
	fileSystem: Pick<FileSystem, "statSync">;
	host: Pick<Host, "platform">;
	native: Seams["native"];
}

/** The executable of a registry command: quoted, or up to `.exe`. */
const COMMAND_EXECUTABLE = /^\s*(?:"([^"]+)"|(\S.*?\.exe)(?=\s|$))/i;

/**
 * The executable a registry open command runs.
 *
 * @param command - Such as `"C:\...\RobloxStudioBeta.exe" %1`.
 * @returns Its path, or `undefined` when it names none.
 */
export function commandExecutable(command: string): string | undefined {
	const match = COMMAND_EXECUTABLE.exec(command);
	return match?.[1] ?? match?.[2];
}

/**
 * Find the Roblox Studio executable, in this order: the `--studio-path`
 * flag, the {@link STUDIO_PATH_VARIABLE} variable (empty means unset), the
 * Windows registry ({@link STUDIO_REGISTRY_KEYS}), then
 * {@link MACOS_STUDIO_PATH}. A found path must be a file.
 *
 * @param seams - The file system, the OS, and the addon (registry reads).
 * @param options - The flag's value and the environment.
 * @param options.env - Holds {@link STUDIO_PATH_VARIABLE}.
 * @param options.studioPath - The `--studio-path` flag, if given.
 * @returns The executable, or `undefined` when none is found: forge then
 *   opens the place through the platform launcher.
 * @throws {ForgeError} `studio_launch_failed` when the flag or the variable
 *   names no file.
 */
export function findStudioExecutable(
	seams: DiscoverySeams,
	{ env, studioPath }: { env: Environment; studioPath?: string | undefined },
): StudioExecutable | undefined {
	if (studioPath !== undefined) {
		return override(seams, studioPath, "flag", "--studio-path");
	}

	const variable = readVariable(env, STUDIO_PATH_VARIABLE, seams.host.platform);
	if (variable !== undefined && variable !== "") {
		return override(seams, variable, "environment", STUDIO_PATH_VARIABLE);
	}

	if (seams.host.platform === "win32") {
		return fromRegistry(seams);
	}

	return seams.host.platform === "darwin" && isFile(seams, MACOS_STUDIO_PATH)
		? { path: MACOS_STUDIO_PATH, source: "application" }
		: undefined;
}

/**
 * The environment of a session whose `start` or `up` got `--studio-path`:
 * the flag, resolved against the project, goes into
 * {@link STUDIO_PATH_VARIABLE}, so the session's open step finds it first.
 *
 * @param environment - The command's environment.
 * @param cwd - The project root.
 * @param platform - The OS.
 * @param flags - The command's flags.
 * @returns The session's environment.
 */
export function withStudioPath(
	environment: Environment,
	cwd: string,
	platform: NodeJS.Platform,
	flags: FlagValues,
): Environment {
	const studioPath = flags[STUDIO_PATH_FLAG.name];
	return typeof studioPath === "string"
		? withVariables(
				environment,
				{ [STUDIO_PATH_VARIABLE]: path.resolve(cwd, studioPath) },
				platform,
			)
		: environment;
}

function isFile(seams: Pick<DiscoverySeams, "fileSystem">, file: string): boolean {
	try {
		return seams.fileSystem.statSync(file).isFile();
	} catch {
		return false;
	}
}

function override(
	seams: DiscoverySeams,
	file: string,
	source: StudioSource,
	name: string,
): StudioExecutable {
	if (!isFile(seams, file)) {
		throw new ForgeError(
			"studio_launch_failed",
			`${name} names ${file}, which is not a file.`,
			{
				hint: `Set ${name} to the Roblox Studio executable, or leave it unset.`,
			},
		);
	}

	return { path: file, source };
}

/**
 * Read one registry key. A missing addon or a failed read counts as no
 * value: forge then falls back to the platform launcher.
 *
 * @param seams - The addon.
 * @param key - The key under `HKEY_CURRENT_USER`.
 * @returns Its default value, or `undefined`.
 */
function readRegistry(seams: Pick<DiscoverySeams, "native">, key: string): string | undefined {
	try {
		return seams.native().readUserRegistryDefault?.(key) ?? undefined;
	} catch {
		return undefined;
	}
}

function fromRegistry(seams: DiscoverySeams): StudioExecutable | undefined {
	for (const key of STUDIO_REGISTRY_KEYS) {
		const command = readRegistry(seams, key);
		const file = command === undefined ? undefined : commandExecutable(command);
		if (file !== undefined && isFile(seams, file)) {
			return { path: file, source: "registry" };
		}
	}

	return undefined;
}
