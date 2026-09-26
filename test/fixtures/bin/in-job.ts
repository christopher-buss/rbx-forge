/**
 * Windows test harness (ADR 0001, "Consequences"): run a command inside a
 * new kill-on-close job, as a host terminal that owns its shells' jobs does.
 *
 * ```text
 * node in-job.ts <addon.node> <breakaway: 0|1> <command> [args...]
 * ```
 *
 * This process joins a new job with `KILL_ON_JOB_CLOSE`, plus
 * `BREAKAWAY_OK` when the second argument is `1`, then starts the command
 * detached, so the command is in this job directly (Node puts non-detached
 * children in its own job, which allows breakaway). The command's output
 * passes through, and this process exits with its exit code. The job closes
 * with this process: whatever did not break away dies then.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

interface TestAddon {
	joinNewJob: (breakawayOk: boolean) => void;
}

const [ADDON_PATH = "", BREAKAWAY = "0", COMMAND = "", ...ARGS] = process.argv.slice(2);
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the addon exports joinNewJob on Windows
const addon = createRequire(import.meta.url)(ADDON_PATH) as TestAddon;
addon.joinNewJob(BREAKAWAY === "1");

const child = spawn(COMMAND, ARGS, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once("close", (code) => {
	process.exitCode = code ?? 1;
});
