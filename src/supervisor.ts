/**
 * Supervisor entry: `forge start` runs this file as a separate process
 * (`supervisor/launcher.ts`), with the session request as its one argument and
 * the owner pipe as its stdin. `forge up` runs it detached
 * (`supervisor/detached-launcher.ts`): no owner pipe, and its messages go to
 * the request's report file until the session is ready. Like `cli.ts`, it is a
 * process entry: it reads argv and the environment, builds the real seams, and
 * exits. Every decision lives in `supervisor/run-supervisor.ts`, where a test
 * drives it.
 *
 * `RBX_FORGE_TEST_PAUSE_DIR` and `RBX_FORGE_TEST_PAUSE` enable the
 * fault-injection pause points (`session/pause.ts`); only tests set them.
 */
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import packageJson from "../package.json" with { type: "json" };
import { ForgeError, toForgeError } from "./errors.ts";
import { nodeClock } from "./seams/clock.ts";
import { nodeFileSystem } from "./seams/file-system.ts";
import { createNodeSeams } from "./seams/node-seams.ts";
import type { Reporter } from "./seams/reporter.ts";
import { createSignals } from "./seams/signals.ts";
import type { Pause } from "./session/pause.ts";
import {
	createFilePause,
	neverPauseAsync,
	parsePausePoints,
	PAUSE_POLL_MS,
} from "./session/pause.ts";
import { createStopSource } from "./session/stop-source.ts";
import type { SessionRequest } from "./supervisor/channel.ts";
import { createChannelReporter, parseSessionRequest } from "./supervisor/channel.ts";
import { watchOwner } from "./supervisor/owner.ts";
import { runSupervisorAsync } from "./supervisor/run-supervisor.ts";

/**
 * Read the request first: a detached supervisor has no owner pipe to watch.
 *
 * @returns The request, or the error that reading it gave.
 */
function readRequest(): ForgeError | SessionRequest {
	try {
		return parseSessionRequest(process.argv[2]);
	} catch (err) {
		return toForgeError(err);
	}
}

const REQUEST = readRequest();
const REPORT = REQUEST instanceof ForgeError ? undefined : REQUEST.detached?.report;

// Next: the owner pipe and the stop signals, so no stop is ever missed.
const stop = createStopSource();
if (REPORT === undefined) {
	watchOwner(process.stdin, stop);
}

createSignals(process).onStop((signal) => {
	stop.request({ signal, type: "signal" });
});

// Writes after `start` died fail; the session stops on the pipe's EOF.
process.stdout.on("error", () => {
	// Nobody reads the output any more.
});

const { env } = process;
const PAUSE_DIRECTORY = env["RBX_FORGE_TEST_PAUSE_DIR"];
const PAUSE_POINTS = parsePausePoints(env["RBX_FORGE_TEST_PAUSE"]);
const PAUSE: Pause =
	PAUSE_DIRECTORY === undefined
		? neverPauseAsync
		: createFilePause({
				clock: nodeClock,
				directory: PAUSE_DIRECTORY,
				fileSystem: nodeFileSystem,
				pid: process.pid,
				points: PAUSE_POINTS,
			});

/**
 * Test only (`RBX_FORGE_TEST_PAUSE=block`): once the test writes
 * `<dir>/block.request`, write `<dir>/block.blocked` (content: this PID)
 * and block the event loop for good, as a hung supervisor that answers
 * nothing (spec #28, F1 and F5). Only a kill ends it.
 *
 * @param directory - The pause directory.
 */
function watchBlockRequest(directory: string): void {
	const request = path.join(directory, "block.request");
	setInterval(() => {
		if (!existsSync(request)) {
			return;
		}

		writeFileSync(path.join(directory, "block.blocked"), String(process.pid));
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	}, PAUSE_POLL_MS).unref();
}

if (PAUSE_DIRECTORY !== undefined && PAUSE_POINTS.has("block")) {
	watchBlockRequest(PAUSE_DIRECTORY);
}

/**
 * Where the supervisor's messages go: to `start` through stdout; when
 * detached, to the report file until the session is ready, and after that
 * to stdout (the supervisor log).
 *
 * @param report - The report file of a detached supervisor.
 * @returns The reporter, and what to call once the session is ready.
 */
function createOutput(report: string | undefined): { onReady: () => void; reporter: Reporter } {
	let target = report;
	const reporter = createChannelReporter((text) => {
		if (target === undefined) {
			process.stdout.write(text);
			return;
		}

		try {
			appendFileSync(target, text);
		} catch {
			// `forge up` is gone and its report with it; nobody reads this.
		}
	});
	return {
		onReady: () => {
			if (target === undefined) {
				return;
			}

			rmSync(target, { force: true });
			target = undefined;
		},
		reporter,
	};
}

/**
 * Run the session and write its result to `start` or `up`.
 *
 * @returns The exit code: the error's, or 0.
 */
async function superviseAsync(): Promise<number> {
	const { onReady, reporter } = createOutput(REPORT);
	try {
		if (REQUEST instanceof ForgeError) {
			throw REQUEST;
		}

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
			REQUEST,
			{ onReady, pause: PAUSE, stop, version: packageJson.version },
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
