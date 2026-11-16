import { openMachineBudget, watchTree } from "@isentinel/machine-budget";

import { spawn, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os, { availableParallelism } from "node:os";
import path from "node:path";
import process from "node:process";

import strykerConfig from "../../stryker.config.ts";
import { runAdaptiveStrykerAsync, startTicking } from "./adaptive.ts";
import { runMutationAsync } from "./mutation.ts";

// Ctrl+C reaches Stryker through the process group; this one stays to publish.
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
	process.on(signal, () => {
		// Stryker handles the signal.
	});
}

const gitCommonDirectory = spawnSync(
	"git",
	["rev-parse", "--path-format=absolute", "--git-common-dir"],
	{ encoding: "utf8", windowsHide: true },
);
if (gitCommonDirectory.status !== 0) {
	throw new Error(`git rev-parse --git-common-dir failed: ${gitCommonDirectory.stderr}`);
}

const COMMON_DIRECTORY = gitCommonDirectory.stdout.trim();
const require = createRequire(import.meta.url);
// The package exports no `bin`; resolve it beside its manifest.
const STRYKER_ENTRY = path.join(
	path.dirname(require.resolve("@stryker-mutator/core/package.json")),
	"bin",
	"stryker.js",
);

function writeAtomically(file: string, contents: string): void {
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, contents);
	try {
		renameSync(temporary, file);
	} catch (err) {
		rmSync(temporary, { force: true });
		throw err;
	}
}

const GROW_INTERVAL_MS = 1000;

const budget = openMachineBudget({
	log: console.error,
	workspaceRoot: path.resolve(import.meta.dirname, "../.."),
});
try {
	process.exitCode = await runMutationAsync({
		files: {
			copy: copyFileSync,
			mkdir: (directory) => {
				mkdirSync(directory, { recursive: true });
			},
			publish: writeAtomically,
			read: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
		},
		localFile: strykerConfig.incrementalFile,
		run: async () => {
			const { code, signal } = await runAdaptiveStrykerAsync({
				budget,
				log: console.error,
				parallelism: availableParallelism(),
				project: "rbx-forge",
				schedule: (tick) => startTicking(tick, GROW_INTERVAL_MS),
				spawn: (environment) => {
					// The IPC channel carries the capacity messages of the
					// patched Stryker.
					return spawn(process.execPath, [STRYKER_ENTRY, "run", "stryker.config.ts"], {
						env: { ...process.env, ...environment },
						stdio: ["inherit", "inherit", "inherit", "ipc"],
						windowsHide: true,
					});
				},
				watchTree,
			});
			if (signal === null) {
				return { code };
			}

			// An unknown signal name still counts as an interruption.
			const { signals } = os.constants;
			return { code: Object.hasOwn(signals, signal) ? 128 + signals[signal] : null };
		},
		sharedFile: path.join(COMMON_DIRECTORY, "stryker", "incremental.json"),
	});
} finally {
	budget.close();
}
