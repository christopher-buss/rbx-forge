import type { Environment } from "../seams/seams.ts";
import { readVariable } from "./environment.ts";

/**
 * Whether this Linux process belongs to a WSL distro.
 * @param platform - Node's host platform.
 * @param environment - The forge process environment.
 * @returns Whether the Linux host names a WSL distro.
 */
export function isWsl(platform: NodeJS.Platform, environment: Environment): boolean {
	return (
		platform === "linux" && readVariable(environment, "WSL_DISTRO_NAME", platform) !== undefined
	);
}
