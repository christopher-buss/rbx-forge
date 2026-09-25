/**
 * `forge` entry. The only module that touches the process: it reads argv, the
 * environment, and the terminal, builds the real seams, and writes the exit
 * code. Every decision lives in `cli/run-cli.ts`, where a test drives it.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";

import packageJson from "../package.json" with { type: "json" };
import { COMMANDS } from "./cli/commands.ts";
import { runCliAsync } from "./cli/run-cli.ts";
import { createNodeSeams } from "./seams/node-seams.ts";

process.exitCode = await runCliAsync(process.argv.slice(2), {
	commands: COMMANDS,
	cwd: process.cwd(),
	env: process.env,
	output: {
		stderr: (text) => {
			process.stderr.write(text);
		},
		stdout: (text) => {
			process.stdout.write(text);
		},
	},
	seams: createNodeSeams({
		input: process.stdin,
		nativeDirectory: process.env["RBX_FORGE_NATIVE_DIR"],
		output: process.stdout,
		// Built next to this file (`dist/supervisor.mjs`).
		supervisorEntry: fileURLToPath(new URL("supervisor.mjs", import.meta.url)),
	}),
	terminal: {
		stdinIsTty: process.stdin.isTTY,
		stdoutIsTty: process.stdout.isTTY,
	},
	version: packageJson.version,
});
