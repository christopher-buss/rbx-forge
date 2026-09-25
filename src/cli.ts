/**
 * `forge` entry. The only module that touches the process: it reads argv,
 * wires the real streams, and writes the exit code. Every decision lives in
 * `cli/run-cli.ts`, where a test drives it.
 */
import process from "node:process";

import packageJson from "../package.json" with { type: "json" };
import { runCli } from "./cli/run-cli.ts";

process.exitCode = runCli(process.argv.slice(2), {
	output: {
		stderr: (text) => {
			process.stderr.write(text);
		},
		stdout: (text) => {
			process.stdout.write(text);
		},
	},
	version: packageJson.version,
});
