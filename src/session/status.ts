import type { Type } from "arktype";
import { type } from "arktype";

import type { Diagnostic } from "../compiler/diagnostics.ts";
import type { HookResult } from "../hooks/run-hooks.ts";
import type { StudioProcess } from "../studio/launcher.ts";

/**
 * The state contract of a session: what `forge status --json`
 * returns and `.forge/sessions/<id>/state.json` holds.
 *
 * ```jsonc
 * {
 *   "running": true, "sessionId": "…", "pid": 1234, "startedAt": "…", "phase": "ready",
 *   "services": {
 *     "rojo":     { "status": "ready", "port": 34872 },
 *     "compiler": { "status": "ready", "building": false,
 *                   "lastBuild": { "startedAt": "…", "at": "…", "errors": 0, "diagnostics": [] } },
 *     "syncback": { "status": "idle", "lastRun": { "at": "…", "ok": true, "durationMs": 812, "hooks": [] } },
 *     "studio":   { "status": "open", "place": "…", "pid": 5678, "startTime": "…" }
 *   }
 * }
 * ```
 */

/** Where a service is: `off` when the session does not run it. */
export type ServiceStatus = "off" | "ready" | "starting" | "stopped";

/** Where the whole session is. */
export type SessionPhase = "ready" | "starting" | "stopped" | "stopping";

/** The last compile of the watch-mode compiler. */
export interface LastBuild {
	/** When it finished, as an ISO date. */
	at: string;
	diagnostics: Array<Diagnostic>;
	errors: number;
	/**
	 * When it started (its start line), as an ISO date; `at` when the
	 * compiler printed no start line.
	 */
	startedAt: string;
}

/** One syncback run with its hooks. */
export interface SyncbackRun {
	durationMs: number;
	/** Why it failed; absent when it succeeded. */
	error?: { code: string; message: string };
	/** Every hook that ran or was skipped, in order. */
	hooks: Array<HookResult>;
	ok: boolean;
}

/** The last syncback run, and when it ended. */
export interface LastSyncback extends SyncbackRun {
	at: string;
}

/**
 * Where Studio is: `off` when the session does not open it; `opening`
 * until its lock file shows the place open; then `open`, and `closed`.
 */
export type StudioStatus = "closed" | "off" | "open" | "opening";

/** The Studio of a session. */
export interface SessionStudio {
	pid?: number;
	place?: string;
	startTime?: string;
	status: StudioStatus;
}

/** One session's state. */
export interface SessionStatus {
	phase: SessionPhase;
	pid: number;
	/** `false` once the session has stopped. */
	running: boolean;
	services: {
		/** `building`: a compile runs (from its start line to its summary). */
		compiler: { building: boolean; lastBuild?: LastBuild; status: ServiceStatus };
		rojo: { port: number; status: ServiceStatus };
		/**
		 * `place`: the place Studio opens or has open, once forge launched
		 * it. `pid` and `startTime`: the Studio forge started directly.
		 */
		studio: SessionStudio;
		/**
		 * `off` when the session does not run syncback on save; `forge sync`
		 * runs still show `running` and their `lastRun`.
		 */
		syncback: { lastRun?: LastSyncback; status: "idle" | "off" | "running" };
	};
	sessionId: string;
	startedAt: string;
}

/** What the session body tells the status as the session runs. */
export interface StatusRecorder {
	/** The watch-mode compiler started a compile, or has none running. */
	building: (isBuilding: boolean) => void;
	/** The watch-mode compiler finished a compile. */
	compiled: (build: LastBuild) => void;
	/**
	 * A service's worker started (`ready` or, for a compiler that reports
	 * compiles, `starting`) or its tree is gone.
	 */
	service: (id: "compiler" | "rojo", status: ServiceStatus) => void;
	/**
	 * Studio was launched with the place, has it open, or closed it.
	 * `process`: the Studio forge started directly, if it did.
	 */
	studio: (
		status: Exclude<StudioStatus, "off">,
		place: string,
		process: null | StudioProcess,
	) => void;
	/** A syncback run ended. */
	syncbackFinished: (run: SyncbackRun) => void;
	/** A syncback run started. */
	syncbackStarted: () => void;
}

/** The status of one session, kept up to date. */
export interface StatusStore extends StatusRecorder {
	/** The session is ending, or has ended. */
	phase: (phase: "stopped" | "stopping") => void;
	/** A copy of the status now. */
	snapshot: () => SessionStatus;
}

/** What a new status starts from. */
export interface StatusStart {
	/** The session runs a watch-mode compiler. */
	compiler: boolean;
	/** The session opens Studio. */
	open: boolean;
	pid: number;
	port: number;
	sessionId: string;
	startedAt: string;
	/** The session runs syncback on save. */
	syncback: boolean;
}

/**
 * Whether a session is ready: Rojo serves, and the compiler, if any, has
 * finished its first compile (or does not report compiles).
 *
 * @param status - The session's status.
 * @returns `true` once `forge up` may return.
 */
export function isReady(status: SessionStatus): boolean {
	return status.phase === "ready";
}

/**
 * Keep a session's status. `onChange` gets every new status, such as to
 * write `state.json`.
 *
 * @param start - The session's identity and what it runs.
 * @param now - The clock, for `at` fields.
 * @param onChange - Gets each new status.
 * @returns A store that starts with every planned service `starting`.
 */
export function createStatusStore(
	start: StatusStart,
	now: () => number,
	onChange: (status: SessionStatus) => void,
): StatusStore {
	const status = initialStatus(start);
	let isEnding = false;
	function changed(): void {
		if (!isEnding) {
			status.phase = derivePhase(status);
		}

		onChange(structuredClone(status));
	}

	return {
		...createRecorder(status, now, changed),
		phase: (phase) => {
			isEnding = true;
			status.phase = phase;
			status.running = phase !== "stopped";
			changed();
		},
		snapshot: () => structuredClone(status),
	};
}

function initialStatus(start: StatusStart): SessionStatus {
	return {
		phase: "starting",
		pid: start.pid,
		running: true,
		services: {
			compiler: { building: false, status: start.compiler ? "starting" : "off" },
			rojo: { port: start.port, status: "starting" },
			studio: { status: start.open ? "opening" : "off" },
			syncback: { status: start.syncback ? "idle" : "off" },
		},
		sessionId: start.sessionId,
		startedAt: start.startedAt,
	};
}

function isoTime(ms: number): string {
	const time = new Date(ms);
	return time.toISOString();
}

/**
 * The recorder half of a store: each call changes `status` in place.
 *
 * @param status - The status it changes.
 * @param now - The clock, for `at` fields.
 * @param changed - Called after each change.
 * @returns What the session body calls.
 */
function createRecorder(
	status: SessionStatus,
	now: () => number,
	changed: () => void,
): StatusRecorder {
	// Between runs, syncback is back where it started: `idle` or `off`.
	const resting = status.services.syncback.status;

	return {
		building: (isBuilding) => {
			status.services.compiler.building = isBuilding;
			changed();
		},
		compiled: (lastBuild) => {
			status.services.compiler = { ...status.services.compiler, lastBuild, status: "ready" };
			changed();
		},
		service: (id, serviceStatus) => {
			status.services[id].status = serviceStatus;
			changed();
		},
		studio: (studioStatus, place, process) => {
			status.services.studio = { ...process, place, status: studioStatus };
			changed();
		},
		syncbackFinished: (run) => {
			status.services.syncback = { lastRun: { at: isoTime(now()), ...run }, status: resting };
			changed();
		},
		syncbackStarted: () => {
			status.services.syncback.status = "running";
			changed();
		},
	};
}

function derivePhase(status: SessionStatus): SessionPhase {
	const { compiler, rojo } = status.services;
	const isCompilerReady = compiler.status === "off" || compiler.status === "ready";
	return isCompilerReady && rojo.status === "ready" ? "ready" : "starting";
}

const TEXT = "string";
const INTEGER = "number.integer";
const INTEGER_OR_NULL = "number.integer | null";

const diagnostic = type({
	code: TEXT,
	column: INTEGER_OR_NULL,
	file: "string | null",
	line: INTEGER_OR_NULL,
	message: TEXT,
	severity: "'error' | 'warning'",
});

const serviceStatus = type("'off' | 'ready' | 'starting' | 'stopped'");

const hookResult = type({
	id: TEXT,
	command: TEXT,
	durationMs: "number",
	exitCode: INTEGER_OR_NULL,
	ok: "boolean",
	outcome: "'failed' | 'skipped' | 'succeeded' | 'timed_out'",
	outputTail: "string[]",
});

const statusSchema: Type<SessionStatus> = type({
	phase: "'ready' | 'starting' | 'stopped' | 'stopping'",
	pid: INTEGER,
	running: "boolean",
	services: {
		compiler: {
			"building": "boolean",
			"lastBuild?": {
				at: TEXT,
				diagnostics: diagnostic.array(),
				errors: INTEGER,
				startedAt: TEXT,
			},
			"status": serviceStatus,
		},
		rojo: { port: INTEGER, status: serviceStatus },
		studio: {
			"pid?": INTEGER,
			"place?": TEXT,
			"startTime?": TEXT,
			"status": "'closed' | 'off' | 'open' | 'opening'",
		},
		syncback: {
			"lastRun?": {
				"at": TEXT,
				"durationMs": "number",
				"error?": { code: TEXT, message: TEXT },
				"hooks": hookResult.array(),
				"ok": "boolean",
			},
			"status": "'idle' | 'off' | 'running'",
		},
	},
	sessionId: TEXT,
	startedAt: TEXT,
});

const hookResults = hookResult.array();

/**
 * Read the hook results a failure's details carry (`hook_failed` and
 * `hook_depth_exceeded` put them in `details.hooks`).
 *
 * @param value - The `hooks` detail.
 * @returns The results; none when there are none.
 */
export function parseHookResults(value: unknown): Array<HookResult> {
	const parsed = hookResults(value);
	return parsed instanceof type.errors ? [] : parsed;
}

/**
 * Read a status that a session sent.
 *
 * @param value - The `status` result.
 * @returns The status, or `undefined` when it is not one.
 */
export function parseStatus(value: unknown): SessionStatus | undefined {
	const parsed = statusSchema(value);
	return parsed instanceof type.errors ? undefined : parsed;
}
