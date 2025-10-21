import { runOutput } from "./run";

/**
 * Converts a WSL path to a Windows path.
 *
 * @example
 *
 * ```ts
 * const winPath = await getWindowsPath("/home/user/project/game.rbxl");
 * // Returns: "\\\\wsl$\\Ubuntu\\home\\user\\project\\game.rbxl"
 * ```
 *
 * @param fsPath - The WSL filesystem path to convert.
 * @returns The Windows-formatted path.
 */
export async function getWindowsPath(fsPath: string): Promise<string> {
	// cspell:ignore wslpath
	const result = await runOutput("wslpath", ["-w", fsPath], {
		shouldShowCommand: false,
	});

	return result.trim();
}
