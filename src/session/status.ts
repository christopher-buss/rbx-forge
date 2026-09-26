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
 *     "rojo":     { "status": "failed", "owner": null, "port": 34872, "exitCode": 1, "outputTail": ["…"] },
 *     "compiler": { "status": "ready", "owner": null, "building": false,
 *                   "lastBuild": { "startedAt": "…", "at": "…", "errors": 0, "diagnostics": [] } },
 *     "syncback": { "status": "idle", "lastRun": { "at": "…", "ok": true, "durationMs": 812, "hooks": [] } },
 *     "studio":   { "status": "open", "owner": null, "place": "…", "pid": 5678, "startTime": "…" }
 *   }
 * }
 * ```
 */

/**
 * Where a service's part is: `off` when it does not run (never started, or
 * stopped on request); `failed` once its service exited by itself.
 */
export type PartStatus = "failed" | "off" | "ready" | "starting";

/** Who owns a part: the `start` terminal, or `null` for none. */
export type PartOwner = "start";

/** How a part's service ended when it failed. */
export interface PartFailure {
	/** The exit code; `null` when a signal or a kill ended it. */
	exitCode: null | number;
	/** The last lines of its output. */
	outputTail: Array<string>;
}

/** A service's part: a failed one also has its {@link PartFailure}. */
export interface ServicePart extends Partial<PartFailure> {
	owner: null | PartOwner;
	status: PartStatus;
}

/** The services a session can run, by their part's name. */
export type ServiceId = "compiler" | "rojo";

/** The parts a session can have: its services and Studio. */
export type PartId = "studio" | ServiceId;

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
	owner: null | PartOwner;
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
		compiler: ServicePart & { building: boolean; lastBuild?: LastBuild };
		/** `port`: once the session chose it; it keeps it from then on. */
		rojo: ServicePart & { port?: number };
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
	/**
	 * The watch-mode compiler finished a compile. `isBuilding`: another one
	 * still runs.
	 */
	compiled: (build: LastBuild, isBuilding: boolean) => void;
	/** A part got an owner (`start` took or added it), or lost it. */
	owner: (part: PartId, owner: null | PartOwner) => void;
	/** The session chose Rojo's port. */
	rojoPort: (port: number) => void;
	/**
	 * A service's worker started (`ready` or, for a compiler that reports
	 * compiles, `starting`), or its tree is gone after a stop (`off`).
	 */
	service: (id: ServiceId, status: Exclude<PartStatus, "failed">) => void;
	/** A service's tree is gone and nothing stopped it: its part failed. */
	serviceFailed: (id: ServiceId, failure: PartFailure) => void;
	/**
	 * The session started its parts: from now on the phase is `ready` once
	 * no part is starting.
	 */
	started: () => void;
	/**
	 * Studio was launched with the place, has it open, or closed it.
	 * `process`: the Studio forge started directly, if it did.
	 */
	studio: (
		status: Exclude<StudioStatus, "off">,
		place: string,
		process: null | StudioProcess,
	) => void;
	/**
	 * The session let go of its Studio, which stays open: `off`, with no
	 * owner.
	 */
	studioLeft: () => void;
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
	/** The owner of every part the session starts with. */
	owner: null | PartOwner;
	pid: number;
	/** Rojo's port, when the session chose it before it started. */
	port: number | undefined;
	/** The session serves Rojo. */
	rojo: boolean;
	sessionId: string;
	startedAt: string;
	/** The session runs syncback on save. */
	syncback: boolean;
}

/**
 * Whether a session is ready: it started its parts, and none is starting. A
 * failed or stopped part does not hold it back.
 *
 * @param status - The session's status.
 * @returns `true` once `forge up` may return.
 */
export function isReady(status: SessionStatus): boolean {
	return status.phase === "ready";
}

export function isoTime(ms: number): string {
	const time = new Date(ms);
	return time.toISOString();
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
	let isStarted = false;
	function changed(): void {
		if (!isEnding && isStarted) {
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
		started: () => {
			isStarted = true;
			changed();
		},
	};
}

function initialStatus(start: StatusStart): SessionStatus {
	function ownerOf(isPlanned: boolean): null | PartOwner {
		return isPlanned ? start.owner : null;
	}

	return {
		phase: "starting",
		pid: start.pid,
		running: true,
		services: {
			compiler: {
				building: false,
				owner: ownerOf(start.compiler),
				status: start.compiler ? "starting" : "off",
			},
			rojo: {
				owner: ownerOf(start.rojo),
				...(start.port === undefined ? {} : { port: start.port }),
				status: start.rojo ? "starting" : "off",
			},
			studio: { owner: ownerOf(start.open), status: start.open ? "opening" : "off" },
			syncback: { status: start.syncback ? "idle" : "off" },
		},
		sessionId: start.sessionId,
		startedAt: start.startedAt,
	};
}

/**
 * Set a part's status; a failure's fields stay only with `failed`.
 *
 * @param part - The part, changed in place.
 * @param next - Its new status, and the failure for `failed`.
 */
function setPart(
	part: ServicePart,
	next: Partial<PartFailure> & Pick<ServicePart, "status">,
): void {
	delete part.exitCode;
	delete part.outputTail;
	Object.assign(part, next);
}

/**
 * The service half of a recorder.
 *
 * @param status - The status it changes.
 * @param changed - Called after each change.
 * @returns What records a service's part.
 */
function createPartRecorder(
	status: SessionStatus,
	changed: () => void,
): Pick<StatusRecorder, "owner" | "rojoPort" | "service" | "serviceFailed"> {
	return {
		owner: (part, owner) => {
			status.services[part].owner = owner;
			changed();
		},
		rojoPort: (port) => {
			status.services.rojo.port = port;
			changed();
		},
		service: (id, partStatus) => {
			setPart(status.services[id], { status: partStatus });
			changed();
		},
		serviceFailed: (id, failure) => {
			setPart(status.services[id], { ...failure, status: "failed" });
			changed();
		},
	};
}

/**
 * The Studio half of a recorder.
 *
 * @param status - The status it changes.
 * @param changed - Called after each change.
 * @returns What records the session's Studio.
 */
function createStudioRecorder(
	status: SessionStatus,
	changed: () => void,
): Pick<StatusRecorder, "studio" | "studioLeft"> {
	return {
		studio: (studioStatus, place, process) => {
			const { owner } = status.services.studio;
			status.services.studio = { ...process, owner, place, status: studioStatus };
			changed();
		},
		studioLeft: () => {
			status.services.studio = { owner: null, status: "off" };
			changed();
		},
	};
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
): Pick<StatusRecorder, Exclude<keyof StatusRecorder, "started">> {
	// Between runs, syncback is back where it started: `idle` or `off`.
	const resting = status.services.syncback.status;

	return {
		building: (isBuilding) => {
			status.services.compiler.building = isBuilding;
			changed();
		},
		compiled: (lastBuild, isBuilding) => {
			const { owner } = status.services.compiler;
			status.services.compiler = { building: isBuilding, lastBuild, owner, status: "ready" };
			changed();
		},
		...createPartRecorder(status, changed),
		...createStudioRecorder(status, changed),
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
	return compiler.status === "starting" || rojo.status === "starting" ? "starting" : "ready";
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

const OWNER = "'start' | null";

const servicePart = type({
	"exitCode?": INTEGER_OR_NULL,
	"outputTail?": "string[]",
	"owner": OWNER,
	"status": "'failed' | 'off' | 'ready' | 'starting'",
});

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
		compiler: servicePart.and({
			"building": "boolean",
			"lastBuild?": {
				at: TEXT,
				diagnostics: diagnostic.array(),
				errors: INTEGER,
				startedAt: TEXT,
			},
		}),
		rojo: servicePart.and({ "port?": INTEGER }),
		studio: {
			"owner": OWNER,
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
