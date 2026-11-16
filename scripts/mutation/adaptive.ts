import type {
	Lease,
	LeaseReport,
	LeaseRequest,
	MachineBudget,
	TreePeaks,
	TreeWatch,
} from "@isentinel/machine-budget";

/** Stryker needs one checker and one test runner to make progress. */
const MINIMUM_STRYKER_WORKERS = 2;

/** The cost of one worker until the budget has learned a real one. */
const INITIAL_WORKER_MEMORY = 1024 * 1024 * 1024;

const BYTES_PER_MIB = 1024 * 1024;

const ADAPTIVE_CAPACITY_ENV = "STRYKER_ADAPTIVE_INITIAL_CAPACITY";

const SET_CAPACITY_TYPE = "stryker:set-capacity";
const CAPACITY_APPLIED_TYPE = "stryker:capacity-applied";

/** The resize message the patched Stryker reads from its IPC channel. */
export interface SetCapacityMessage {
	/** The total workers, checkers and test runners together. */
	readonly capacity: number;
	readonly type: typeof SET_CAPACITY_TYPE;
}

/** How the Stryker process ended; both are `null` when it never started. */
export interface ChildExit {
	readonly code: null | number;
	readonly signal: NodeJS.Signals | null;
}

/** The parts of a spawned Stryker process the adaptive runner uses. */
export interface StrykerChild {
	/** Fires when the process could not start or the IPC send failed. */
	on(event: "error", listener: (error: Error) => void): unknown;
	on(
		event: "exit",
		listener: (code: null | number, signal: NodeJS.Signals | null) => void,
	): unknown;
	on(event: "message", listener: (message: unknown) => void): unknown;
	/** Absent when the process could not start. */
	readonly pid?: number | undefined;
	/** The callback takes a closed-channel error. */
	send(message: SetCapacityMessage, callback: (error: Error | null) => void): boolean;
}

export interface AdaptiveStrykerOptions {
	readonly budget: MachineBudget;
	readonly log: (line: string) => void;
	/** Logical cores of the machine. */
	readonly parallelism: number;
	/** Names the learned cost. */
	readonly project: string;
	/** Calls the tick until the returned cancel runs. */
	readonly schedule: (tick: () => void) => () => void;
	/** Starts Stryker with these extra environment variables. */
	readonly spawn: (environment: Record<string, string>) => StrykerChild;
	readonly watchTree: (pid: number) => TreeWatch;
}

interface StrykerRun {
	readonly leases: Array<Lease>;
	readonly options: AdaptiveStrykerOptions;
	readonly request: LeaseRequest;
}

interface RunningStryker extends StrykerRun {
	readonly child: StrykerChild;
}

/**
 * The Stryker default of one less than the logical cores, but never below a
 * checker and a test runner.
 * @param parallelism - Logical cores, as `os.availableParallelism()` reports.
 * @returns The worker ceiling for one run.
 */
export function maxStrykerWorkers(parallelism: number): number {
	return Math.max(MINIMUM_STRYKER_WORKERS, parallelism - 1);
}

export function buildStrykerLeaseRequest(options: {
	parallelism: number;
	project: string;
}): LeaseRequest {
	return {
		cost: { pass: "stryker", project: options.project },
		isMainLaneOnly: true,
		maxWorkers: maxStrykerWorkers(options.parallelism),
		memoryPerWorker: INITIAL_WORKER_MEMORY,
		minWorkers: MINIMUM_STRYKER_WORKERS,
	};
}

export function workersToGrow(options: { cap: number; held: number; max: number }): number {
	return Math.max(0, Math.min(options.cap, options.max) - options.held);
}

/**
 * The report a released lease records.
 * @param peaks - The peaks the tree watch read.
 * @returns The report, or `undefined` when the platform read no tree peak.
 */
export function buildLeaseReport(peaks: TreePeaks): LeaseReport | undefined {
	if (peaks.peakMemory === undefined) {
		return undefined;
	}

	return peaks.peakPerWorker === undefined
		? { peakMemory: peaks.peakMemory }
		: { peakMemory: peaks.peakMemory, peakPerWorker: peaks.peakPerWorker };
}

export function describePeaks(report: LeaseReport): string {
	const perWorker =
		report.peakPerWorker === undefined
			? "unknown"
			: `${String(Math.round(report.peakPerWorker / BYTES_PER_MIB))} MiB`;
	return `peak ${String(Math.round(report.peakMemory / BYTES_PER_MIB))} MiB, ${perWorker} per worker`;
}

export function setCapacityMessage(capacity: number): SetCapacityMessage {
	return { capacity, type: SET_CAPACITY_TYPE };
}

/**
 * Reads the capacity a running Stryker reports it has applied.
 * @param message - A message from the Stryker IPC channel.
 * @returns The capacity, or `undefined` for any other message.
 */
export function parseCapacityApplied(message: unknown): number | undefined {
	if (typeof message !== "object" || message === null) {
		return undefined;
	}

	if (!("type" in message) || message.type !== CAPACITY_APPLIED_TYPE) {
		return undefined;
	}

	return "capacity" in message && typeof message.capacity === "number"
		? message.capacity
		: undefined;
}

/**
 * Runs Stryker on workers leased from the machine budget, and grows the run
 * over IPC while the run cap allows. On exit it releases every lease and
 * reports the tree peaks on the first one only, so one run is one sample.
 * @param options - The budget, the process launcher and the tree watch.
 * @returns How Stryker ended.
 */
export async function runAdaptiveStrykerAsync(options: AdaptiveStrykerOptions): Promise<ChildExit> {
	const request = buildStrykerLeaseRequest(options);
	const first = await options.budget.leaseAsync(request);
	const leases = [first];
	let report: LeaseReport | undefined;
	try {
		const outcome = await superviseAsync({ leases, options, request });
		({ report } = outcome);
		return outcome.exit;
	} finally {
		first.release(report);
		for (const lease of leases.slice(1)) {
			lease.release();
		}
	}
}

/**
 * Calls a tick on a fixed interval that does not keep the process alive.
 * @param tick - The function to call.
 * @param intervalMs - Milliseconds between two calls.
 * @returns A function that stops the ticks.
 */
export function startTicking(tick: () => void, intervalMs: number): () => void {
	const timer = setInterval(tick, intervalMs);
	timer.unref();
	return () => {
		clearInterval(timer);
	};
}

function heldWorkers(leases: ReadonlyArray<Lease>): number {
	return leases.reduce((total, lease) => total + lease.workers, 0);
}

function ignoreClosedChannel(): void {
	// Stryker may exit between a tick and the send; the exit handler ends the
	// run.
}

function growOnce(run: RunningStryker): void {
	const { budget, log, project } = run.options;
	const count = workersToGrow({
		cap: budget.runCapWorkers(run.request),
		held: heldWorkers(run.leases),
		max: run.request.maxWorkers,
	});
	const lease =
		count === 0
			? undefined
			: budget.tryLease({ ...run.request, maxWorkers: count, minWorkers: 1 });
	if (lease === undefined) {
		return;
	}

	run.leases.push(lease);
	const capacity = heldWorkers(run.leases);
	run.child.send(setCapacityMessage(capacity), ignoreClosedChannel);
	log(`stryker: growing ${project} to ${String(capacity)} worker(s)`);
}

async function waitForExitAsync(child: StrykerChild): Promise<ChildExit> {
	return new Promise((resolve) => {
		child.on("error", () => {
			resolve({ code: null, signal: null });
		});
		child.on("exit", (code, signal) => {
			resolve({ code, signal });
		});
	});
}

async function superviseAsync({
	leases,
	options,
	request,
}: StrykerRun): Promise<{ exit: ChildExit; report: LeaseReport | undefined }> {
	const { log, project } = options;
	const workers = heldWorkers(leases);
	const child = options.spawn({ [ADAPTIVE_CAPACITY_ENV]: String(workers) });
	const watch = child.pid === undefined ? undefined : options.watchTree(child.pid);
	log(`stryker: leased ${String(workers)} worker(s) for ${project}`);
	child.on("message", (message) => {
		const applied = parseCapacityApplied(message);
		if (applied !== undefined) {
			log(`stryker: ${project} runs ${String(applied)} worker(s)`);
		}
	});

	const cancel = options.schedule(() => {
		growOnce({ child, leases, options, request });
	});
	const exit = await waitForExitAsync(child);
	cancel();
	const report = watch === undefined ? undefined : buildLeaseReport(watch.stop());
	if (report !== undefined) {
		log(`stryker: ${project} ${describePeaks(report)}`);
	}

	return { exit, report };
}
