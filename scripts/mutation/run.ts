import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import strykerConfig from "../../stryker.config.ts";
import { runMutation } from "./mutation.ts";

// Ctrl+C reaches Stryker through the process group; this one stays to publish.
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
	process.on(signal, () => {
		// Stryker handles the signal.
	});
}

const COMMON_DIRECTORY = spawnSync(
	"git",
	["rev-parse", "--path-format=absolute", "--git-common-dir"],
	{ encoding: "utf8", windowsHide: true },
).stdout.trim();
const require = createRequire(import.meta.url);
// The package exports no `bin`; resolve it beside its manifest.
const STRYKER_ENTRY = path.join(
	path.dirname(require.resolve("@stryker-mutator/core/package.json")),
	"bin",
	"stryker.js",
);

process.exitCode = runMutation({
	files: {
		copy: copyFileSync,
		mkdir: (directory) => {
			mkdirSync(directory, { recursive: true });
		},
		read: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
		rename: renameSync,
		write: writeFileSync,
	},
	localFile: strykerConfig.incrementalFile,
	run: () => {
		const { signal, status } = spawnSync(
			process.execPath,
			[STRYKER_ENTRY, "run", "stryker.config.ts"],
			{
				stdio: "inherit",
				windowsHide: true,
			},
		);
		return { code: signal === null ? status : 128 + os.constants.signals[signal] };
	},
	sharedFile: path.join(COMMON_DIRECTORY, "stryker", "incremental.json"),
});
