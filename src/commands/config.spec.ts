import { describe, expect, it, vi } from "vitest";

import { createCommandContext, createTestSeams, PROJECT } from "../../test/helpers/seams.ts";
import type { ConfigLoader } from "../seams/config-loader.ts";
import { runConfigAsync } from "./config.ts";

const PATH = `${PROJECT}/rbx-forge.config.ts`;

function contextWithFile(value: unknown): ReturnType<typeof createCommandContext> {
	const configLoader = vi.fn<ConfigLoader>().mockResolvedValue({ path: PATH, value });
	return createCommandContext({ seams: createTestSeams({ configLoader }) });
}

describe(runConfigAsync, () => {
	it("should return the resolved config and its file", async () => {
		expect.assertions(1);

		const result = await runConfigAsync(contextWithFile({ projectType: "luau" }), {
			config: { rojoPort: 5000 },
			flags: {},
		});

		expect(result.data).toMatchObject({
			config: { buildOutputPath: "game.rbxl", projectType: "luau", rojoPort: 5000 },
			path: PATH,
		});
	});

	it("should show the file and the config as indented JSON", async () => {
		expect.assertions(2);

		const { summary } = await runConfigAsync(contextWithFile({ projectType: "luau" }), {
			config: {},
			flags: {},
		});

		expect(summary).toStartWith(`${PATH}\n{\n\t"buildOutputPath": "game.rbxl",`);
		expect(JSON.parse(summary.slice(PATH.length + 1))).toMatchObject({
			projectType: "luau",
			typegen: { include: ["**"] },
		});
	});
});
