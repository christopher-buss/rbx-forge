import { describe, expect, it, vi } from "vitest";

import type { ConfigLoader } from "../seams/config-loader.ts";
import { loadProjectConfigAsync } from "./load.ts";

const CWD = "/project";
const PATH = "/project/rbx-forge.config.ts";

function loaderFor(value: unknown): ConfigLoader {
	return vi.fn<ConfigLoader>().mockResolvedValue({ path: PATH, value });
}

describe(loadProjectConfigAsync, () => {
	it("should resolve the file's config over the defaults, under the flags", async () => {
		expect.assertions(1);

		const loaded = await loadProjectConfigAsync(
			CWD,
			loaderFor({ buildOutputPath: "file.rbxl", projectType: "luau", rojoPort: 4000 }),
			{ rojoPort: 5000 },
		);

		expect(loaded).toMatchObject({
			config: {
				buildOutputPath: "file.rbxl",
				projectType: "luau",
				rojoAlias: "rojo",
				rojoPort: 5000,
			},
			path: PATH,
		});
	});

	it("should look for the config file in the project directory", async () => {
		expect.assertions(1);

		const loader = loaderFor({ projectType: "rbxts" });
		await loadProjectConfigAsync(CWD, loader, {});

		expect(loader).toHaveBeenCalledExactlyOnceWith(CWD);
	});

	it("should fail with config_not_found and point at init when there is no file", async () => {
		expect.assertions(1);

		await expect(
			loadProjectConfigAsync(CWD, vi.fn<ConfigLoader>().mockResolvedValue(undefined), {}),
		).rejects.toMatchObject({
			code: "config_not_found",
			hint: "Run `forge init` to create rbx-forge.config.ts.",
			message: "No rbx-forge config file in /project.",
		});
	});

	it("should fail with config_load_failed when the file cannot be evaluated", async () => {
		expect.assertions(1);

		const cause = new SyntaxError("Unexpected token");

		await expect(
			loadProjectConfigAsync(CWD, vi.fn<ConfigLoader>().mockRejectedValue(cause), {}),
		).rejects.toMatchObject({
			cause,
			code: "config_load_failed",
			message: "Could not load the config file: Unexpected token",
		});
	});

	it("should describe a thrown value that is not an Error", async () => {
		expect.assertions(1);

		await expect(
			loadProjectConfigAsync(CWD, vi.fn<ConfigLoader>().mockRejectedValue("boom"), {}),
		).rejects.toMatchObject({ message: "Could not load the config file: boom" });
	});

	it("should fail with config_invalid for an unknown key", async () => {
		expect.assertions(1);

		await expect(
			loadProjectConfigAsync(CWD, loaderFor({ projectType: "rbxts", serve: {} }), {}),
		).rejects.toMatchObject({
			code: "config_invalid",
			message: `Invalid config in ${PATH}:\nserve must be removed`,
		});
	});
});
