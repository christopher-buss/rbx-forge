import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { EXIT_SUCCESS } from "../../src/exit-codes.ts";

// Runs after `build`: spawns the shipped bin, which imports `dist/cli.mjs`.
const BIN = path.join(import.meta.dirname, "..", "..", "bin", "rbx-forge.js");

interface BinRun {
	status: null | number;
	stderr: string;
	stdout: string;
}

async function runBinAsync(argv: Array<string>): Promise<BinRun> {
	const child = spawn(process.execPath, [BIN, ...argv], {
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});

	onTestFinished(() => {
		child.kill();
	});

	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});

	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (status) => {
			resolve({ status, stderr, stdout });
		});
	});
}

describe("forge bin", () => {
	it("should exit 0 printing the package version", async () => {
		expect.assertions(1);

		await expect(runBinAsync(["--version"])).resolves.toStrictEqual({
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
});
