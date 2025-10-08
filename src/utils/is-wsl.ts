import process, { platform } from "node:process";

export function isWsl(): boolean {
	return platform === "linux" && process.env["WSL_DISTRO_NAME"] !== undefined;
}
