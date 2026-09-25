import path from "node:path";
import { describe, expect, it } from "vitest";

import { makeTemporaryDirectory } from "../../test/helpers/temporary-directory.ts";
import { loadConfigFileAsync } from "./config-loader.ts";

// Real c12 against temp files that do not import the package, so jiti never
// evaluates `src` and coverage stays clean.
describe(loadConfigFileAsync, () => {
	it("should resolve undefined when the project has no config file", async () => {
		expect.assertions(1);

		await expect(loadConfigFileAsync(makeTemporaryDirectory())).resolves.toBeUndefined();
	});

	it("should load a TypeScript config file's default export", async () => {
		expect.assertions(1);

		const directory = makeTemporaryDirectory({
			"rbx-forge.config.ts": 'export default { projectType: "luau" as const };\n',
		});

		await expect(loadConfigFileAsync(directory)).resolves.toStrictEqual({
			path: path.join(directory, "rbx-forge.config.ts").replaceAll("\\", "/"),
			value: { projectType: "luau" },
		});
	});

	it("should keep arrays exactly as the file wrote them", async () => {
		expect.assertions(1);

		const directory = makeTemporaryDirectory({
			"rbx-forge.config.json": JSON.stringify({ typegen: { include: ["Workspace/**"] } }),
		});

		await expect(loadConfigFileAsync(directory)).resolves.toMatchObject({
			value: { typegen: { include: ["Workspace/**"] } },
		});
	});

	it("should ignore rc files and package.json keys", async () => {
		expect.assertions(1);

		const directory = makeTemporaryDirectory({
			".rbx-forgerc": "projectType=luau\n",
			"package.json": JSON.stringify({ "rbx-forge": { projectType: "luau" } }),
		});

		await expect(loadConfigFileAsync(directory)).resolves.toBeUndefined();
	});

	it("should reject when the config file throws", async () => {
		expect.assertions(1);

		const directory = makeTemporaryDirectory({
			"rbx-forge.config.ts": 'throw new Error("broken config");\n',
		});

		await expect(loadConfigFileAsync(directory)).rejects.toThrow("broken config");
	});
});
