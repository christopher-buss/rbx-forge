import { describe, it } from "vitest";

import { isWsl } from "./wsl.ts";

describe(isWsl, () => {
	it.for([
		["linux", { WSL_DISTRO_NAME: "Ubuntu" }, true],
		["linux", {}, false],
		["win32", { WSL_DISTRO_NAME: "Ubuntu" }, false],
		["darwin", { WSL_DISTRO_NAME: "Ubuntu" }, false],
	] as const)("detects WSL on %s with %j", ([platform, environment, expected], { expect }) => {
		expect.assertions(1);
		expect(isWsl(platform, environment)).toBe(expected);
	});
});
