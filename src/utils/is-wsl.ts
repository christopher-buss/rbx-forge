import { platform } from "node:process";

export function isWsl(): boolean {
	return platform === "linux" && Bun.env["WSL_DISTRO_NAME"] !== undefined;
}
