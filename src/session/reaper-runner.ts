import { constants } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { ForgeError } from "../errors.ts";
import type { LogFile } from "../output/log-file.ts";
import type { ProcessOutcome, ProcessRunner, ProcessSpec } from "../process/process-runner.ts";
import { OUTPUT_TAIL_LINES } from "../process/process-runner.ts";
import type { WorkerReport } from "../reaper/protocol.ts";
import type { Reaper, SpawnedWorker } from "../reaper/reaper-client.ts";
import type { Clock } from "../seams/clock.ts";
import type { FileSystem } from "../seams/file-system.ts";
import { followOutput } from "./output-follower.ts";

/** What a {@link createReaperRunner} runs with. */
export interface ReaperRunnerOptions {
	/** Prefix of each run's worker id, such as `start` for `start-1`. */
	name: string;
	clock: Clock;
	fileSystem: FileSystem;
	/** Gets every run's output, after a header line per run. */
	log: LogFile;
	/** The session's reaper, admitted. */
	reaper: Pick<Reaper, "spawnAsync" | "stop">;
	/** Aborts once the session stops: no run starts after that. */
	signal: AbortSignal;
	/** Folder for each run's raw output while it runs. */
	spoolDirectory: string;
}

/** A run that could not start. */
type SpawnFailure = Extract<ProcessOutcome, { type: "spawn_failed" }>;

/** Signal names by POSIX number, such as `9` → `SIGKILL`. */
const SIGNAL_NAMES: ReadonlyMap<number, NodeJS.Signals> = new Map<number, NodeJS.Signals>(
	Object.entries(constants.signals).map(([name, number]) => {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `os.constants.signals` keys are signal names
		return [Number(number), name as NodeJS.Signals] as const;
	}),
);

/**
 * A {@link ProcessRunner} that runs every process as a worker of the
 * session's reaper, so one-shot steps and hooks are owned like services: a
 * timeout kills the whole tree, and the session's end kills every run.
 *
 * The reaper writes a run's output to a file in `spoolDirectory`; once the
 * run ends, each line goes to `onLine` and to the rotated `log`, and the file
 * is removed.
 *
 * @param options - The reaper, output folders, and clock.
 * @returns A process runner over the reaper.
 */
export function createReaperRunner(options: ReaperRunnerOptions): ProcessRunner {
	let count = 0;
	return async (spec) => {
		count += 1;
		return runAsync(options, `${options.name}-${count}`, spec);
	};
}

function signalName(report: WorkerReport): NodeJS.Signals | null {
	return report.signal === null ? null : (SIGNAL_NAMES.get(report.signal) ?? null);
}

/**
 * Start one run, or say why it could not start.
 *
 * @param options - The runner's options.
 * @param id - The worker id.
 * @param spec - The process.
 * @returns The worker, or why the reaper rejected it.
 * @rejects {ForgeError} `reaper_unavailable` when the reaper is gone.
 */
async function spawnAsync(
	{ reaper, signal }: ReaperRunnerOptions,
	id: string,
	spec: ProcessSpec & { log: string },
): Promise<SpawnedWorker | SpawnFailure> {
	if (signal.aborted) {
		return {
			errorCode: undefined,
			message: `The session is stopping, so ${id} did not start.`,
			type: "spawn_failed",
		};
	}

	try {
		return await reaper.spawnAsync({
			id,
			args: spec.args,
			cwd: spec.cwd,
			env: spec.env,
			file: spec.file,
			log: spec.log,
			...(spec.verbatimArguments === true ? { verbatimArguments: true } : {}),
		});
	} catch (err) {
		if (err instanceof ForgeError && err.code === "process_failed") {
			return { errorCode: undefined, message: err.message, type: "spawn_failed" };
		}

		throw err;
	}
}

/**
 * Whether the run outlives its timeout. Stops its tree when it does.
 *
 * @param options - The reaper and clock.
 * @param worker - The run.
 * @param timeoutMs - The limit; none when `undefined`.
 * @returns Whether the timeout came first.
 */
async function outlivesAsync(
	{ clock, reaper }: ReaperRunnerOptions,
	worker: SpawnedWorker,
	timeoutMs: number | undefined,
): Promise<boolean> {
	if (timeoutMs === undefined) {
		return false;
	}

	const abort = new AbortController();
	// Once the run ends first, the abort rejects a timer nobody waits for.
	const timer = clock.sleep(timeoutMs, abort.signal).then(() => true);
	const isTimedOut = await Promise.race([worker.exited.then(() => false), timer]);
	abort.abort();
	if (isTimedOut) {
		reaper.stop(worker.id, 0);
	}

	return isTimedOut;
}

/**
 * Read a finished run's output: every line to `onLine` and the log, the last
 * lines kept.
 *
 * @param options - The file system and log.
 * @param spool - The run's output file, removed afterwards.
 * @param onLine - The spec's line callback.
 * @returns The last {@link OUTPUT_TAIL_LINES} lines.
 */
function drain(
	{ fileSystem, log }: ReaperRunnerOptions,
	spool: string,
	onLine: ProcessSpec["onLine"],
): Array<string> {
	const lines: Array<string> = [];
	followOutput(fileSystem, spool, (line) => {
		onLine?.(line);
		log.write(stripVTControlCharacters(line));
		lines.push(line);
	}).finish();
	fileSystem.rmSync(spool, { force: true });
	return lines.slice(-OUTPUT_TAIL_LINES);
}

async function runAsync(
	options: ReaperRunnerOptions,
	id: string,
	spec: ProcessSpec,
): Promise<ProcessOutcome> {
	const { clock, fileSystem, log, spoolDirectory } = options;
	fileSystem.mkdirSync(spoolDirectory, { recursive: true });
	const spool = path.join(spoolDirectory, `${id}.log`);
	const startedAt = clock.now();
	const worker = await spawnAsync(options, id, { ...spec, log: spool });
	if (!("exited" in worker)) {
		return worker;
	}

	log.write(`--- ${id}: ${[spec.file, ...spec.args].join(" ")} ---`);
	const isTimedOut = await outlivesAsync(options, worker, spec.timeoutMs);
	const report = await worker.exited;
	const outputTail = drain(options, spool, spec.onLine);
	const durationMs = clock.now() - startedAt;
	if (isTimedOut) {
		return { durationMs, outputTail, type: "timed_out" };
	}

	return {
		durationMs,
		exitCode: report.exitCode,
		outputTail,
		signal: signalName(report),
		type: "exited",
	};
}
