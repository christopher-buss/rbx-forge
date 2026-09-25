import type { Type } from "arktype";
import { type } from "arktype";

import type { Environment } from "../seams/seams.ts";

/**
 * The reaper protocol, host side: one JSON object per line. The host writes
 * {@link ReaperRequest}s to the reaper's stdin and reads
 * {@link ReaperEvent}s from its stdout. The Rust side is
 * `reaper/src/protocol.rs`; change both together.
 */

/** One worker for the reaper to start. */
export interface WorkerSpec {
	/** The host's name for the worker, unique among live workers. */
	id: string;
	args: ReadonlyArray<string>;
	cwd: string;
	/** The worker's whole environment; the reaper adds the markers. */
	env: Environment;
	/** Absolute path of the executable. */
	file: string;
	/** File that gets stdout and stderr, appended. None: discarded. */
	log?: string;
	/** Windows only: pass `args` joined, unquoted (escaped cmd.exe lines). */
	verbatimArguments?: boolean;
}

/** A message to the reaper. */
export type ReaperRequest =
	| { graceMs: number; id: string; type: "stop" }
	| { graceMs: number; type: "terminate" }
	| { type: "go" }
	| { type: "spawn"; worker: WorkerSpec };

/** How one worker's tree ended. */
export interface WorkerReport {
	/** The leader's exit code; `null` when a signal ended it. */
	exitCode: null | number;
	/** The reaper killed the tree: the graceful stop ran out of time. */
	forced: boolean;
	/** Members still lived when the reaper stopped waiting for them. */
	incomplete: boolean;
	/** The POSIX signal number that ended the leader. */
	signal: null | number;
	/**
	 * POSIX: the PIDs of the members that still lived. The reaper always
	 * sends the list (empty on Windows, which cannot name them); a report the
	 * host makes for a dead reaper has none.
	 */
	survivors?: Array<number>;
}

/** Why the reaper started no worker for a `spawn`. */
export type RejectReason = "duplicate_id" | "not_admitted" | "spawn_failed" | "terminating";

/** One worker in `terminated`. */
export interface FinalReport {
	id: string;
	report: WorkerReport;
}

/** A message from the reaper. */
export type ReaperEvent =
	| { id: string; message: string; reason: RejectReason; type: "rejected" }
	| { id: string; pid: number; startTime: string; type: "spawned" }
	| { id: string; report: WorkerReport; type: "exited" }
	| { pid: number; type: "leased" }
	| { reports: Array<FinalReport>; type: "terminated" };

const report = type({
	"exitCode": "number.integer | null",
	"forced": "boolean",
	"incomplete": "boolean",
	"signal": "number.integer | null",
	"survivors?": "number.integer[]",
});

const eventSchema: Type<ReaperEvent> = type.or(
	{ pid: "number.integer", type: "'leased'" },
	{ id: "string", pid: "number.integer", startTime: "string", type: "'spawned'" },
	{
		id: "string",
		message: "string",
		reason: "'duplicate_id' | 'not_admitted' | 'spawn_failed' | 'terminating'",
		type: "'rejected'",
	},
	{ id: "string", report, type: "'exited'" },
	{ reports: type({ id: "string", report }).array(), type: "'terminated'" },
);

const eventLine = type("string.json.parse").pipe(eventSchema);

/**
 * Write one request as a line.
 *
 * @param request - What to send.
 * @returns The JSON text and a newline.
 */
export function encodeRequest(request: ReaperRequest): string {
	if (request.type !== "spawn") {
		return `${JSON.stringify(request)}\n`;
	}

	const { worker } = request;
	const line = {
		id: worker.id,
		args: worker.args,
		cwd: worker.cwd,
		env: definedVariables(worker.env),
		file: worker.file,
		log: worker.log,
		type: "spawn",
		verbatim: worker.verbatimArguments === true,
	};
	return `${JSON.stringify(line)}\n`;
}

/**
 * Read one line from the reaper.
 *
 * @param line - One line of its stdout, without the newline.
 * @returns The event, or `undefined` when the line is not one.
 */
export function parseEvent(line: string): ReaperEvent | undefined {
	const event = eventLine(line);
	return event instanceof type.errors ? undefined : event;
}

function definedVariables(environment: Environment): Record<string, string> {
	const defined: Record<string, string> = {};
	for (const [name, value] of Object.entries(environment)) {
		if (value !== undefined) {
			defined[name] = value;
		}
	}

	return defined;
}
