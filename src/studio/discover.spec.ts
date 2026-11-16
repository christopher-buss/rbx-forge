import path from "node:path";
import { describe, it } from "vitest";

import { withStudioPath } from "./discover.ts";

describe(withStudioPath, () => {
	it.for([
		String.raw`D:\temp\agents\RobloxStudioBeta.exe`,
		String.raw`\\wsl.localhost\Ubuntu\home\developer\Studio.exe`,
	])("preserves a WSL Windows flag %s", (file, { expect }) => {
		expect.assertions(1);
		expect(
			withStudioPath({ WSL_DISTRO_NAME: "Ubuntu" }, "/project", "linux", {
				"studio-path": file,
			}),
		).toEqual({ RBX_FORGE_STUDIO_PATH: file, WSL_DISTRO_NAME: "Ubuntu" });
	});

	it("resolves a Linux flag relative to the WSL project", ({ expect }) => {
		expect.assertions(1);
		expect(
			withStudioPath({ WSL_DISTRO_NAME: "Ubuntu" }, "/project", "linux", {
				"studio-path": "Studio.exe",
			}),
		).toHaveProperty("RBX_FORGE_STUDIO_PATH", path.posix.resolve("/project", "Studio.exe"));
	});
});
