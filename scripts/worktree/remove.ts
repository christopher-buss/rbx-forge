import { spawnSync } from "node:child_process";
import process from "node:process";
import { text } from "node:stream/consumers";

import { runWorktreeRemove } from "./worktree.ts";

const result = runWorktreeRemove({
	platform: process.platform,
	spawn: (command, args) => {
		return spawnSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
			windowsHide: true,
		});
	},
	stdin: await text(process.stdin),
});
process.stderr.write(result.stderr);
process.exitCode = result.code;
