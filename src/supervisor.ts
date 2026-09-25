/**
 * Supervisor entry: `forge start` runs this file as a separate process
 * (`supervisor/launcher.ts`), with the session request as its one argument
 * and the owner pipe as its stdin. Like `cli.ts`, it is a process entry: it
 * reads argv and the environment, builds the real seams, and exits. Every
 * decision lives in `supervisor/run-supervisor.ts`, where a test drives it.
 *
 * `RBX_FORGE_TEST_PAUSE_DIR` and `RBX_FORGE_TEST_PAUSE` enable the
 * fault-injection pause points (`session/pause.ts`); only tests set them.
 */
import process from "node:process";

import packageJson from "../package.json" with { type: "json" };
import { toForgeError } from "./errors.ts";
import { nodeClock } from "./seams/clock.ts";
import { nodeFileSystem } from "./seams/file-system.ts";
import { createNodeSeams } from "./seams/node-seams.ts";
import { createSignals } from "./seams/signals.ts";
import type { Pause } from "./session/pause.ts";
import { createFilePause, neverPauseAsync, parsePausePoints } from "./session/pause.ts";
import { createStopSource } from "./session/stop-source.ts";
import { createChannelReporter, parseSessionRequest } from "./supervisor/channel.ts";
import { watchOwner } from "./supervisor/owner.ts";
import { runSupervisorAsync } from "./supervisor/run-supervisor.ts";

// First: the owner pipe and the stop signals, so no stop is ever missed.
const stop = createStopSource();
watchOwner(process.stdin, stop);
createSignals(process).onStop((signal) => {
	stop.request({ signal, type: "signal" });
});

// Writes after `start` died fail; the session stops on the pipe's EOF.
process.stdout.on("error", () => {
	// Nobody reads the output any more.
});

const { env } = process;
const PAUSE_DIRECTORY = env["RBX_FORGE_TEST_PAUSE_DIR"];
const PAUSE: Pause =
	PAUSE_DIRECTORY === undefined
		? neverPauseAsync
		: createFilePause({
				clock: nodeClock,
				directory: PAUSE_DIRECTORY,
				fileSystem: nodeFileSystem,
				pid: process.pid,
				points: parsePausePoints(env["RBX_FORGE_TEST_PAUSE"]),
			});

/**
 * Run the session and write its result to `start`.
 *
 * @returns The exit code: the error's, or 0.
 */
async function superviseAsync(): Promise<number> {
	const reporter = createChannelReporter((text) => {
		process.stdout.write(text);
	});
	try {
		const result = await runSupervisorAsync(
			{
				cwd: process.cwd(),
				env,
				interactive: false,
				reporter,
				seams: createNodeSeams({
					// Never prompts: the run is not interactive.
					input: process.stdin,
					nativeDirectory: env["RBX_FORGE_NATIVE_DIR"],
					output: process.stderr,
					supervisorEntry: import.meta.filename,
				}),
			},
			parseSessionRequest(process.argv[2]),
			{ pause: PAUSE, stop, version: packageJson.version },
		);
		reporter.succeed("start", result);
		return 0;
	} catch (err) {
		const { code, details, exitCode, hint, message } = toForgeError(err);
		reporter.fail({ code, command: "start", details, exitCode, hint, message });
		return exitCode;
	}
}

process.exitCode = await superviseAsync();
// The owner pipe keeps stdin open: exit once the result is written out.
process.stdout.write("", () => {
	process.exit();
});
