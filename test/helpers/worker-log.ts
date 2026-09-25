import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

/** One `start` record a fake worker appends to `FIXTURE_LOG`. */
export interface WorkerRecord {
	args: Array<string>;
	/** When the process started, in milliseconds since the Unix epoch. */
	at: number;
	event: "start";
	markers: { session?: string; worker?: string };
	pid: number;
	ppid: number;
	role: string;
}

const POLL_MS = 50;

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
 * Force-kill every recorded worker. Safe on already-dead PIDs.
 *
 * @param records - Workers to kill.
 */
export function killWorkers(records: ReadonlyArray<WorkerRecord>): void {
	for (const { pid } of records) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
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
		const alive = readWorkerLog(logFile).filter(({ pid }) => isProcessAlive(pid));
		if (alive.length === 0 || Date.now() > deadline) {
			return;
		}

		killWorkers(alive);
		await sleep(POLL_MS);
	}
}
