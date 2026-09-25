import { describe, expect, it } from "vitest";

import { EXIT_SUCCESS, EXIT_USAGE } from "../exit-codes.ts";
import { runCli } from "./run-cli.ts";

interface Captured {
	code: number;
	stderr: string;
	stdout: string;
}

function run(argv: Array<string>): Captured {
	let stdout = "";
	let stderr = "";
	const code = runCli(argv, {
		output: {
			stderr: (text) => {
				stderr += text;
			},
			stdout: (text) => {
				stdout += text;
			},
		},
		version: "1.2.3",
	});

	return { code, stderr, stdout };
}

describe(runCli, () => {
	it("should print the version for --version", () => {
		expect.assertions(1);

		expect(run(["--version"])).toStrictEqual({
			code: EXIT_SUCCESS,
			stderr: "",
			stdout: "1.2.3\n",
		});
	});

	it("should print the version for -v", () => {
		expect.assertions(1);

		expect(run(["-v"]).stdout).toBe("1.2.3\n");
	});

	it("should print the help page listing every flag for --help", () => {
		expect.assertions(1);

		// The whole page is the contract: agents and people read it.
		expect(run(["--help"])).toStrictEqual({
			code: EXIT_SUCCESS,
			stderr: "",
			stdout: [
				"forge - supervised Rojo and roblox-ts sessions.",
				"",
				"Usage",
				"  forge [options]",
				"",
				"Options",
				"  -h, --help     Show this help and exit.",
				"  -v, --version  Print the version and exit.",
				"",
			].join("\n"),
		});
	});

	it("should print help when run without arguments", () => {
		expect.assertions(1);

		expect(run([])).toStrictEqual(run(["--help"]));
	});

	it("should exit with the usage code naming an unknown flag", () => {
		expect.assertions(3);

		const result = run(["--nope"]);

		expect(result.code).toBe(EXIT_USAGE);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("--nope");
	});

	it("should exit with the usage code naming an unknown command", () => {
		expect.assertions(2);

		const result = run(["serve"]);

		expect(result.code).toBe(EXIT_USAGE);
		expect(result.stderr).toStartWith('forge: unknown command "serve"\n');
	});
});
