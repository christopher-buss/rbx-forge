import { isWsl } from "./is-wsl";

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
