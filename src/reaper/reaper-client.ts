import assert from "node:assert/strict";
import type { ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { ForgeError } from "../errors.ts";
import type { NativeLoader } from "../native/addon.ts";
import type { ChildProcessRunner } from "../seams/child-process.ts";
import type { Clock } from "../seams/clock.ts";
import type { Host } from "../seams/host.ts";
import type {
	FinalReport,
	ReaperEvent,
	ReaperRequest,
	WorkerReport,
	WorkerSpec,
} from "./protocol.ts";
import { encodeRequest, parseEvent } from "./protocol.ts";

/** What the host side of the reaper needs. */
export interface ReaperBackend {
	childProcess: ChildProcessRunner;
	clock: Clock;
	host: Pick<Host, "platform">;
	/** Kills what a dead reaper left behind. */
	native: NativeLoader;
}

/** One session's reaper. */
export interface ReaperOptions {
	/** Path of the `forge-reaper` binary. */
	file: string;
	/** The lease file; the reaper holds a shared lock on it. */
	leasePath: string;
	/** Tags every worker (`RBX_FORGE_SESSION`) and names its jobs. */
	sessionId: string;
}

/** A worker the reaper started. */
export interface SpawnedWorker {
	id: string;
	/** Resolves once the worker's whole tree is gone. */
	exited: Promise<WorkerReport>;
	pid: number;
	/** OS start time of the leader (see `processStartTime`). */
	startTime: string;
}

/** How a reaper ended. */
export interface ReaperEnd {
	/** Every worker's final report, in the order their trees emptied. */
	reports: Array<FinalReport>;
	/**
	 * The reaper confirmed that every tree was empty (`terminated`). When
	 * `false`, it died first, and the host killed every worker it knew of.
	 */
	terminated: boolean;
}

/**
 * The host side of one reaper process. The host holds the only write end of
 * the reaper's stdin: when the host dies, the reaper sees EOF and kills
 * every tree.
 */
export interface Reaper {
	/** Resolves once the reaper process has exited. */
	ended: Promise<ReaperEnd>;
	/** Admit spawns. Send it only while the session is not shutting down. */
	go: () => void;
	readonly pid: number;
	/**
	 * Start a worker in its own job or process group.
	 *
	 * @rejects {ForgeError} `process_failed` when the reaper rejects it, or
	 *   `reaper_unavailable` when the reaper exits first.
	 */
	spawnAsync: (worker: WorkerSpec) => Promise<SpawnedWorker>;
	/** Stop one worker: graceful signal, forced kill after `graceMs`. */
	stop: (id: string, graceMs: number) => void;
	/**
	 * End the reaper: it rejects later spawns, stops every worker with
	 * `graceMs`, and exits. When it does not exit within `graceMs` plus
	 * {@link TERMINATE_MARGIN_MS}, the host closes its stdin; after one more
	 * margin, the host kills it and its workers.
	 */
	terminateAsync: (graceMs: number) => Promise<ReaperEnd>;
}

/**
 * Starts one session's reaper: {@link launchReaperAsync} with the binary
 * found for this host.
 */
export type ReaperLauncher = (
	options: Pick<ReaperOptions, "leasePath" | "sessionId">,
) => Promise<Reaper>;

/** Extra time the reaper gets at each step of `terminateAsync`. */
export const TERMINATE_MARGIN_MS = 5000;
/** How long the host waits for a worker it killed after the reaper died. */
export const ORPHAN_WAIT_MS = 2000;

/** How much of the reaper's stderr an error message repeats. */
const STDERR_TAIL = 2000;

type ReaperProcess = ChildProcessByStdio<Writable, Readable, Readable>;

interface PendingSpawn {
	reject: (error: ForgeError) => void;
	resolve: (worker: SpawnedWorker) => void;
}

interface LiveWorker {
	pid: number;
	resolve: (report: WorkerReport) => void;
	startTime: string;
}

/** Everything one reaper's host side tracks. */
interface Session {
	backend: ReaperBackend;
	child: ReaperProcess;
	/** The reaper process has exited; nothing more reaches it. */
	closed: boolean;
	live: Map<string, LiveWorker>;
	pending: Map<string, PendingSpawn>;
	reports: Array<FinalReport>;
	/**
	 * Settles the launch: the reaper's PID once it holds the lease, or
	 * `undefined` when it failed or exited first. Later calls do nothing.
	 */
	started: (pid: number | undefined) => void;
	stderr: () => string;
	terminated: Array<FinalReport> | undefined;
}

/**
 * Start a reaper and wait until it holds the lease. It spawns nothing until
 * {@link Reaper.go}.
 *
 * @param backend - The spawn seam, clock, host, and native addon.
 * @param options - The binary, lease file, and session id.
 * @returns The reaper, leased and waiting for `go`.
 * @rejects {ForgeError} `reaper_unavailable` when it cannot start or exits
 *   before it takes the lease.
 */
export async function launchReaperAsync(
	backend: ReaperBackend,
	options: ReaperOptions,
): Promise<Reaper> {
	const child = spawnReaper(backend, options);
	const { promise: started, resolve } = Promise.withResolvers<number | undefined>();
	const session: Session = {
		backend,
		child,
		closed: false,
		live: new Map(),
		pending: new Map(),
		reports: [],
		started: resolve,
		stderr: keepTail(child.stderr),
		terminated: undefined,
	};
	const ended = watchAsync(session);

	const pid = await started;
	if (pid === undefined) {
		throw new ForgeError(
			"reaper_unavailable",
			`The reaper (${options.file}) exited before it took the lease.${tailOf(session)}`,
		);
	}

	return makeReaper(session, ended, pid);
}

/**
 * Make the launcher the seams hand to commands.
 *
 * @param backend - The spawn seam, clock, host, and native addon.
 * @param locate - Finds the `forge-reaper` binary; throws
 *   `reaper_unavailable` when it is missing.
 * @returns A launcher that finds the binary on every launch.
 */
export function createReaperLauncher(backend: ReaperBackend, locate: () => string): ReaperLauncher {
	return async (options) => launchReaperAsync(backend, { ...options, file: locate() });
}

function ignore(): void {
	// Nothing to do.
}

function spawnReaper(backend: ReaperBackend, options: ReaperOptions): ReaperProcess {
	const child: ReaperProcess = backend.childProcess.spawn(
		options.file,
		["serve", "--session", options.sessionId, "--lease", options.leasePath],
		{
			// POSIX: its own session, so terminal signals never reach it.
			detached: backend.host.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	// Writes after the reaper died fail; its exit is reported instead.
	child.stdin.on("error", ignore);
	return child;
}

function tailOf(session: Session): string {
	const tail = session.stderr();
	return tail === "" ? "" : `\n${tail}`;
}

/**
 * Remove and return an entry the reaper named.
 *
 * @template T - The entry type.
 * @param entries - Pending spawns or live workers.
 * @param id - The worker id from the event.
 * @returns The entry.
 */
function take<T>(entries: Map<string, T>, id: string): T {
	const entry = entries.get(id);
	// The reaper answers only spawns it was sent, and reports only workers
	// it spawned.
	assert(entry !== undefined);
	entries.delete(id);
	return entry;
}

function settle(session: Session, id: string): PendingSpawn {
	return take(session.pending, id);
}

function onExited(session: Session, id: string, report: WorkerReport): void {
	const worker = take(session.live, id);
	session.reports.push({ id, report });
	worker.resolve(report);
}

function onSpawned(session: Session, id: string, pid: number, startTime: string): void {
	const { promise: exited, resolve } = Promise.withResolvers<WorkerReport>();
	session.live.set(id, { pid, resolve, startTime });
	settle(session, id).resolve({ id, exited, pid, startTime });
}

function dispatch(session: Session, event: ReaperEvent): void {
	switch (event.type) {
		case "exited": {
			onExited(session, event.id, event.report);
			break;
		}
		case "leased": {
			session.started(event.pid);
			break;
		}
		case "rejected": {
			const message = `The reaper did not start ${event.id}: ${event.message}`;
			const details = { reason: event.reason };
			settle(session, event.id).reject(
				new ForgeError("process_failed", message, { details }),
			);
			break;
		}
		case "spawned": {
			onSpawned(session, event.id, event.pid, event.startTime);
			break;
		}
		case "terminated": {
			session.terminated = event.reports;
			break;
		}
	}
}

function exitedBefore(session: Session, id: string): ForgeError {
	return new ForgeError(
		"reaper_unavailable",
		`The reaper exited before it started ${id}.${tailOf(session)}`,
	);
}

/**
 * Kill the tree of a worker a dead reaper left behind, through a pin on its
 * leader: only a process with the recorded start time is killed.
 *
 * @param backend - The native addon.
 * @param worker - The worker's leader.
 * @returns Whether the leader is gone.
 */
function killOrphan(backend: ReaperBackend, worker: LiveWorker): boolean {
	try {
		const pinned = backend.native().pinProcess(worker.pid);
		if (pinned?.startTime !== worker.startTime) {
			return true;
		}

		pinned.killGroup();
		return pinned.waitForExit(ORPHAN_WAIT_MS);
	} catch {
		return false;
	}
}

function end(session: Session): ReaperEnd {
	for (const [id, pending] of session.pending) {
		pending.reject(exitedBefore(session, id));
	}

	if (session.terminated !== undefined) {
		return { reports: session.terminated, terminated: true };
	}

	for (const [id, worker] of session.live) {
		const report = {
			exitCode: null,
			forced: true,
			incomplete: !killOrphan(session.backend, worker),
			signal: null,
		};
		session.reports.push({ id, report });
		worker.resolve(report);
	}

	return { reports: session.reports, terminated: false };
}

/**
 * Follow the reaper's events and its exit.
 *
 * @param session - The reaper's state.
 * @returns Resolves with how it ended, once it has exited.
 */
async function watchAsync(session: Session): Promise<ReaperEnd> {
	const { child } = session;
	createInterface({ input: child.stdout }).on("line", (line) => {
		const event = parseEvent(line);
		if (event !== undefined) {
			dispatch(session, event);
		}
	});
	// A spawn failure ends the launch; after the launch, the exit reports
	// any failure.
	child.on("error", () => {
		session.started(undefined);
	});

	return new Promise((resolve) => {
		child.once("close", () => {
			session.closed = true;
			session.started(undefined);
			resolve(end(session));
		});
	});
}

function keepTail(stream: Readable): () => string {
	let text = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		text = `${text}${chunk}`.slice(-STDERR_TAIL);
	});
	return () => text.trim();
}

function send(session: Session, request: ReaperRequest): void {
	session.child.stdin.write(encodeRequest(request));
}

/**
 * Whether `promise` settles within `ms`.
 *
 * @param clock - Runs the timer.
 * @param promise - What to wait for; it never rejects.
 * @param ms - The limit.
 * @returns `true` when it settled first.
 */
async function settlesWithinAsync(
	clock: Clock,
	promise: Promise<unknown>,
	ms: number,
): Promise<boolean> {
	const abort = new AbortController();
	// Once the abort fires the timer rejects, but the race has settled and
	// ignores it.
	const timer = clock.sleep(ms, abort.signal).then(() => false);
	const hasSettled = await Promise.race([promise.then(() => true), timer]);
	abort.abort();
	return hasSettled;
}

/**
 * `terminate`, with the bounded escalation of {@link Reaper.terminateAsync}.
 *
 * @param session - The reaper's state.
 * @param ended - Resolves once the reaper has exited.
 * @param graceMs - The workers' graceful stop time.
 * @returns How the reaper ended.
 */
async function terminateAsync(
	session: Session,
	ended: Promise<ReaperEnd>,
	graceMs: number,
): Promise<ReaperEnd> {
	const { clock } = session.backend;
	send(session, { graceMs, type: "terminate" });
	if (await settlesWithinAsync(clock, ended, graceMs + TERMINATE_MARGIN_MS)) {
		return ended;
	}

	// stdin EOF: the reaper forces every tree without grace.
	session.child.stdin.end();
	if (!(await settlesWithinAsync(clock, ended, TERMINATE_MARGIN_MS))) {
		session.child.kill("SIGKILL");
	}

	return ended;
}

function makeReaper(session: Session, ended: Promise<ReaperEnd>, pid: number): Reaper {
	return {
		ended,
		go: () => {
			send(session, { type: "go" });
		},
		pid,
		spawnAsync: async (worker) => {
			if (session.closed) {
				throw exitedBefore(session, worker.id);
			}

			return new Promise((resolve, reject) => {
				session.pending.set(worker.id, { reject, resolve });
				send(session, { type: "spawn", worker });
			});
		},
		stop: (id, graceMs) => {
			send(session, { id, graceMs, type: "stop" });
		},
		terminateAsync: async (graceMs) => terminateAsync(session, ended, graceMs),
	};
}
