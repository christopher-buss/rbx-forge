import { describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { EXIT_SUCCESS, EXIT_USAGE } from "../../src/exit-codes.ts";
import { parseLines } from "../helpers/output.ts";
import { runBinAsync } from "./run-bin.ts";

describe("forge bin", () => {
	it("should exit 0 printing the package version", async () => {
		expect.assertions(1);

		await expect(runBinAsync(["--version"])).resolves.toMatchObject({
			status: EXIT_SUCCESS,
			stderr: "",
			stdout: `${packageJson.version}\n`,
		});
	});

	it("should exit 0 printing the help page", async () => {
		expect.assertions(3);

		const { status, stderr, stdout } = await runBinAsync(["--help"]);

		expect(status).toBe(EXIT_SUCCESS);
		expect(stderr).toBe("");
		expect(stdout).toContain("--version");
	});

	it("should exit 2 with an NDJSON usage error for an unknown command", async () => {
		expect.assertions(2);

		const { status, stdout } = await runBinAsync(["serve"]);

		expect(status).toBe(EXIT_USAGE);
		expect(parseLines(stdout)).toStrictEqual([
			{
				command: null,
				error: {
					code: "usage",
					hint: 'Run "forge --help" for usage.',
					message: 'Unknown command "serve".',
				},
				exitCode: EXIT_USAGE,
				ok: false,
				type: "result",
			},
		]);
	});
});
