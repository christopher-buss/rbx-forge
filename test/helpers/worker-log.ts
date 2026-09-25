import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import type { NativeAddon, PinnedProcess } from "../../src/native/addon.ts";
import { startTimeToEpochMs } from "../../src/native/start-time.ts";
import { nodeHost } from "../../src/seams/host.ts";
import { loadRealNative } from "./real-native.ts";

/** One `start` record a fake worker appends to `FIXTURE_LOG`. */
export interface WorkerRecord {
	args: Array<string>;
	/** When the process started, in milliseconds since the Unix epoch. */
	at: number;
	event: "start";
	markers: { session?: string; worker?: string };
	/** A grandchild's `FIXTURE_GRANDCHILD_MODES` entry. */
	mode?: string;
	pid: number;
	ppid: number;
	role: string;
}

const POLL_MS = 50;
/**
 * How much later than its record a worker's OS start time may read: Linux
 * start times count 10 ms ticks from a boot time forge reads from uptime.
 */
const START_SLACK_MS = process.platform === "linux" ? 1000 : 100;

let native: NativeAddon | undefined;

/**
 * Read every record in a fixture log. A missing file means no worker started.
 *
 * @param logFile - The `FIXTURE_LOG` path.
 * @returns Records in start order.
 */
export function readWorkerLog(logFile: string): Array<WorkerRecord> {
	if (!existsSync(logFile)) {
		return [];
	}

	return readFileSync(logFile, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fake-worker.ts writes this shape
			return JSON.parse(line) as unknown as WorkerRecord;
		});
}

/**
 * Wait until at least `count` workers have started.
 *
 * @param logFile - The `FIXTURE_LOG` path.
 * @param count - Records to wait for.
 * @param timeoutMs - Give up after this long.
 * @returns The records once `count` is reached.
 * @rejects When the timeout passes first.
 */
export async function waitForWorkersAsync(
	logFile: string,
	count: number,
	timeoutMs = 10_000,
): Promise<Array<WorkerRecord>> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const records = readWorkerLog(logFile);
		if (records.length >= count) {
			return records;
		}

		if (Date.now() > deadline) {
			throw new Error(`expected ${count} workers in ${logFile}, saw ${records.length}`);
		}

		await sleep(POLL_MS);
	}
}

/**
 * Whether a process with this PID exists (signal 0 probe).
 *
 * @param pid - Process id.
 * @returns True while the process exists.
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: the process exists but belongs to someone else.
		return err instanceof Error && "code" in err && err.code === "EPERM";
	}
}

/**
 * Wait until none of `pids` is alive.
 *
 * @param pids - Processes that should die.
 * @param timeoutMs - Give up after this long.
 * @returns The PIDs still alive at the end: empty when all died.
 */
export async function waitForDeathAsync(
	pids: ReadonlyArray<number>,
	timeoutMs = 10_000,
): Promise<Array<number>> {
	const deadline = Date.now() + timeoutMs;
	let alive = pids.filter(isProcessAlive);
	while (alive.length > 0 && Date.now() < deadline) {
		await sleep(POLL_MS);
		alive = alive.filter(isProcessAlive);
	}

	return alive;
}

/**
 * Pin the process a record names, only while it is still that process. A
 * worker writes its record after it started, so a process that started
 * later reused the PID: a test file running in parallel may own it (Windows
 * reuses PIDs within seconds), and killing it breaks that test.
 *
 * @param record - The worker's record.
 * @param record.at - When it wrote the record.
 * @param record.pid - Its PID.
 * @returns The pin; `undefined` when the PID has exited, was reused, or
 *   cannot be opened.
 */
export function pinRecorded({
	at,
	pid,
}: Pick<WorkerRecord, "at" | "pid">): PinnedProcess | undefined {
	let pin: null | PinnedProcess;
	try {
		pin = realNative().pinProcess(pid);
	} catch {
		// Another user's process: not a fixture process.
		return undefined;
	}

	if (pin === null) {
		return undefined;
	}

	const startedMs = startTimeToEpochMs(pin.startTime, process.platform, nodeHost.bootTimeMs());
	return startedMs !== undefined && startedMs <= at + START_SLACK_MS ? pin : undefined;
}

/**
 * Force-kill every recorded worker that still runs, through a pin: never a
 * process that reused a recorded PID.
 *
 * @param records - Workers to kill.
 */
export function killWorkers(records: ReadonlyArray<WorkerRecord>): void {
	for (const record of records) {
		try {
			pinRecorded(record)?.kill();
		} catch {
			// It exited meanwhile.
		}
	}
}

/**
 * Force-kill every worker the log records until none is left: a storm may
 * record new workers while the kills run. Gives up after `timeoutMs`.
 *
 * @param logFile - The `FIXTURE_LOG` path.
 * @param timeoutMs - The bound.
 */
export async function killLoggedWorkersAsync(logFile: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const alive = readWorkerLog(logFile).filter((record) => pinRecorded(record) !== undefined);
		if (alive.length === 0 || Date.now() > deadline) {
			return;
		}

		killWorkers(alive);
		await sleep(POLL_MS);
	}
}

/**
 * Pin a process the test knows runs now, to kill it later: a kill by PID
 * could hit a process that reused the PID meanwhile.
 *
 * @param pid - The running process.
 * @returns The pin, or `undefined` when it has exited.
 */
export function pinNow(pid: number): PinnedProcess | undefined {
	try {
		return realNative().pinProcess(pid) ?? undefined;
	} catch {
		return undefined;
	}
}

function realNative(): NativeAddon {
	native ??= loadRealNative();
	return native;
}
