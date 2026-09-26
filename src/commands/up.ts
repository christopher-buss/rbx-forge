import assert from "node:assert/strict";
import path from "node:path";

import type { FlagDefinition } from "../cli/flags.ts";
import type { KnownSession } from "../client/session.ts";
import { addPartsAsync, JOIN_SILENCE_MS, probeSessionAsync } from "../client/session.ts";
import { ForgeError } from "../errors.ts";
import type { PinnedProcess } from "../native/addon.ts";
import type { CommandResult } from "../seams/reporter.ts";
import { listParts } from "../session/part-names.ts";
import type { AddablePart, PartRequest } from "../session/part-requests.ts";
import { isPartRunning } from "../session/part-stops.ts";
import type { PartId, SessionStatus } from "../session/status.ts";
import { isReady } from "../session/status.ts";
import { STUDIO_PATH_FLAG } from "../studio/discover.ts";
import type { SessionRequest, SupervisorMessage } from "../supervisor/channel.ts";
import { failureError, parseMessage } from "../supervisor/channel.ts";
import type { ForgeFiles } from "../supervisor/session-files.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import type { CommandContext, CommandInput } from "./context.ts";
import { START_FLAGS } from "./start.ts";

export const UP_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "compiler",
		kind: "boolean",
		text: "Run the compiler in watch mode (the default); --no-compiler starts no part.",
	},
	...START_FLAGS.filter(({ name }) => name === "force"),
	{
		name: "studio",
		kind: "boolean",
		text: "Also attach Studio with the place open, and Rojo; the Studio that has it open already is used.",
	},
	{ ...STUDIO_PATH_FLAG, text: `${STUDIO_PATH_FLAG.text} Needs --studio.` },
	...START_FLAGS.filter(({ name }) => name === "syncback"),
];

/**
 * How long `up` waits for a session to be ready: the first compile included.
 */
export const UP_TIMEOUT_MS = 300_000;
/** How often `up` looks at the session. */
export const UP_POLL_MS = 100;

type ResultMessage = Extract<SupervisorMessage, { type: "result" }>;

/** A ready session, the parts this `up` started, and whether it started it. */
interface Ready {
	added: Array<PartId>;
	isStarted: boolean;
	status: SessionStatus;
}

/** The parts `up` names, in the order a session starts them. */
const PART_IDS: ReadonlyArray<PartId> = ["compiler", "studio", "rojo"];

/** A supervisor this `up` started, and its report file. */
interface Launched {
	pid: number;
	pin: null | PinnedProcess;
	/** Characters of the report already read. */
	read: number;
	report: string;
}

/** Where one `up` is. */
interface UpState {
	/** The parts a session added for this `up`; unset until it asked. */
	added: Array<PartId> | undefined;
	deadline: number;
	/** When a session last answered, or when `up` began to wait for one. */
	lastAnswer: number;
	launched: Launched | undefined;
	relaunched: boolean;
	/** The parts `up` asks for, and the Studio executable to start. */
	wanted: PartRequest;
}

/**
 * Say where each part that runs is.
 *
 * @param status - The session's status.
 * @returns Such as `the compiler is ready, Rojo serves on port 34872`.
 */
export function describeParts({ services }: SessionStatus): string {
	const { compiler, rojo } = services;
	const parts: Array<string> = [];
	if (compiler.status !== "off") {
		parts.push(`the compiler is ${compiler.status}`);
	}

	if (rojo.status === "ready") {
		parts.push(`Rojo serves on port ${rojo.port}`);
	} else if (rojo.status !== "off") {
		parts.push(`Rojo is ${rojo.status}`);
	}

	if (isPartRunning(services, "studio")) {
		parts.push(describeStudio(services.studio));
	}

	return parts.length === 0 ? "no part runs" : parts.join(", ");
}

/**
 * `forge up`: start the dev session in the background with the watch-mode
 * compiler, and return once no part starts: the compiler finished its first
 * compile or stopped. With `--studio`, it then attaches Studio with the
 * place open (the Studio that has it open already, else a new one) and Rojo
 * on the session's port, and returns once Rojo listens and Studio has the
 * place open. The session runs in a detached supervisor
 * (`supervisor/detached-launcher.ts`) until `forge down`; a failed service
 * stops only its part, and the attached Studio's close stops only its Rojo.
 * A project with no compiler gets a session with no part.
 *
 * It is idempotent: when a session runs, it starts only the parts that are
 * missing or failed, reports them in `added`, and never touches a part that
 * runs (`started: false`); when one is starting, it waits for it. Two `up`s
 * at once start one session: the second supervisor finds the singleton lock
 * taken, and its `up` joins the first one's session.
 *
 * @param context - The run: project root, environment, seams, and reporter.
 * @param input - The parsed flags.
 * @returns The session's status, the parts this `up` started, and whether
 *   it started the session.
 * @rejects {ForgeError} `usage`; `detach_unsupported` when the host forbids
 *   a detached process; the session's own startup failure (such as
 *   `compiler_missing`); an attach failure (such as `port_in_use`);
 *   `supervisor_unresponsive` when it is not ready in time.
 */
export async function runUpAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const { clock } = context.seams;
	const wanted = wantedParts(context, input.flags);
	const request: SessionRequest = {
		compiler: input.flags["compiler"] !== false,
		config: input.config,
		open: false,
	};
	const found = await probeSessionAsync(context.seams, forgeFiles(context.cwd));
	const now = clock.now();
	const state: UpState = {
		added: undefined,
		deadline: now + UP_TIMEOUT_MS,
		lastAnswer: now,
		launched:
			found === undefined ? launch(context, forgeFiles(context.cwd), request) : undefined,
		relaunched: false,
		wanted,
	};
	const { added, isStarted, status } = await waitReadyAsync(context, request, state);
	const session = isStarted
		? `Started session ${status.sessionId}`
		: `Found session ${status.sessionId} and ${describeAdded(added)}`;
	return {
		data: { ...status, added, started: isStarted },
		summary: `${session}: ${describeParts(status)}.`,
	};
}

function describeStudio({ place, status }: SessionStatus["services"]["studio"]): string {
	return status === "open" ? `Studio has ${place} open` : `Studio is ${status}`;
}

/**
 * What `up` asks a session to add: the compiler unless `--no-compiler`,
 * Studio with `--studio`.
 *
 * @param context - The project root, for `--studio-path`.
 * @param flags - The parsed flags.
 * @returns The parts, and the Studio executable to start.
 * @throws {ForgeError} `usage` for `--studio-path` without `--studio`.
 */
function wantedParts(context: CommandContext, flags: CommandInput["flags"]): PartRequest {
	const studioPath = flags[STUDIO_PATH_FLAG.name];
	const hasStudio = flags["studio"] === true;
	if (typeof studioPath === "string" && !hasStudio) {
		throw new ForgeError("usage", "--studio-path needs --studio.");
	}

	const parts: Array<AddablePart> = flags["compiler"] === false ? [] : ["compiler"];
	return {
		parts: hasStudio ? [...parts, "studio"] : parts,
		...(typeof studioPath === "string"
			? { studioPath: path.resolve(context.cwd, studioPath) }
			: {}),
	};
}

function describeAdded(added: ReadonlyArray<PartId>): string {
	return added.length === 0 ? "added no part" : `started ${listParts(added)}`;
}

/**
 * Start a detached supervisor with a new report file.
 *
 * @param context - The seams.
 * @param forge - The project's `.forge` files.
 * @param request - What the session runs.
 * @returns The supervisor.
 * @throws {ForgeError} `detach_unsupported`.
 */
function launch(
	{ cwd, env, seams }: CommandContext,
	forge: ForgeFiles,
	request: SessionRequest,
): Launched {
	const directory = path.join(forge.directory, "launch");
	seams.fileSystem.mkdirSync(directory, { recursive: true });
	const report = path.join(directory, `${seams.randomId()}.ndjson`);
	const pid = seams.detachedSupervisor({
		cwd,
		env,
		request: { ...request, detached: { report } },
	});
	return { pid, pin: seams.native().pinProcess(pid), read: 0, report };
}

function forget(context: CommandContext, launched: Launched): void {
	context.seams.fileSystem.rmSync(launched.report, { force: true });
}

function readReport(context: CommandContext, launched: Launched): ResultMessage | undefined {
	const { fileSystem } = context.seams;
	let text: string;
	try {
		text = fileSystem.readFileSync(launched.report, "utf8");
	} catch {
		// Not written yet, or removed once the session was ready.
		return undefined;
	}

	const end = text.lastIndexOf("\n") + 1;
	const lines = text.slice(launched.read, end).split("\n");
	launched.read = Math.max(launched.read, end);
	let result: ResultMessage | undefined;
	for (const line of lines) {
		const message = parseMessage(line);
		if (message?.type === "event") {
			context.reporter.emit(message.event);
		} else if (message?.type === "result") {
			result = message;
		}
	}

	return result;
}

function crashed(context: CommandContext): ForgeError {
	return new ForgeError("internal_error", "The session's supervisor exited without a result.", {
		hint: `Its output is in ${path.join(context.cwd, ".forge", "logs", "supervisor.log")}.`,
	});
}

/**
 * Look at the supervisor this `up` started: pass its events on, and act on
 * its result.
 *
 * @param context - The reporter and seams.
 * @param state - Where `up` is.
 * @throws The session's failure; `internal_error` when the supervisor died
 *   without a result; `not_running` when the session ended before it was
 *   ready.
 */
function checkLaunched(context: CommandContext, state: UpState): void {
	const { launched } = state;
	if (launched === undefined) {
		return;
	}

	const isAlive = launched.pin?.isAlive() === true;
	const result = readReport(context, launched);
	if (result === undefined) {
		if (!isAlive) {
			forget(context, launched);
			throw crashed(context);
		}

		return;
	}

	forget(context, launched);
	if (!result.ok && result.error.code === "session_running") {
		// Another `up` or `start` won the race: wait for its session.
		state.launched = undefined;
		state.lastAnswer = context.seams.clock.now();
		return;
	}

	throw result.ok
		? new ForgeError("not_running", `The session ended before it was ready: ${result.summary}`)
		: failureError(result.error);
}

function runningParts(status: SessionStatus): Array<PartId> {
	return PART_IDS.filter((id) => isPartRunning(status.services, id));
}

/**
 * Ask the session to add the parts `up` wants, once: a session this `up`
 * did not start, and its own one for Studio, which it starts without.
 *
 * @param context - The seams.
 * @param state - Where `up` is; notes what was added.
 * @param found - The session that answered, and its status.
 * @param found.session - Its identity record and token.
 * @param found.status - Its status, for its PID.
 * @returns Whether it asked now: the status it has is from before the add.
 * @rejects {ForgeError} The add's failure, such as `compiler_missing` or
 *   `port_in_use`; `not_running` passes as no answer.
 */
async function addOnceAsync(
	context: CommandContext,
	state: UpState,
	{ session, status }: { session: KnownSession; status: SessionStatus },
): Promise<boolean> {
	const isOwn = status.pid === state.launched?.pid;
	if ((isOwn && !state.wanted.parts.includes("studio")) || state.added !== undefined) {
		return false;
	}

	try {
		// The session answers once its own parts started: a whole startup.
		state.added = await addPartsAsync(context.seams.ipc, session, state.wanted, UP_TIMEOUT_MS);
	} catch (err) {
		// The session ended meanwhile: wait for the next one, as for silence.
		if (!(err instanceof ForgeError) || err.code !== "not_running") {
			throw err;
		}
	}

	return true;
}

/**
 * Ask the project's session for its status. A session this `up` did not
 * start is first asked to add the parts `up` wants.
 *
 * @param context - The seams.
 * @param state - Where `up` is; notes the answer.
 * @returns The status once the session is ready, else `undefined`.
 * @rejects {ForgeError} As {@link addOnceAsync}.
 */
async function probeReadyAsync(
	context: CommandContext,
	state: UpState,
): Promise<Ready | undefined> {
	const found = await probeSessionAsync(context.seams, forgeFiles(context.cwd));
	if (found === undefined) {
		return undefined;
	}

	state.lastAnswer = context.seams.clock.now();
	if ((await addOnceAsync(context, state, found)) || !isReady(found.status)) {
		return undefined;
	}

	const { launched } = state;
	if (launched !== undefined) {
		forget(context, launched);
	}

	// Every part of a session this `up` started is its own; any other session
	// was asked.
	const isStarted = found.status.pid === launched?.pid;
	const added = isStarted ? runningParts(found.status) : state.added;
	assert(added !== undefined);
	return {
		added,
		isStarted,
		status: found.status,
	};
}

function unresponsive(what: string): ForgeError {
	return new ForgeError("supervisor_unresponsive", what, {
		hint: 'Check "forge logs start" and "forge status", or stop the session and try again.',
	});
}

/**
 * Give up once the time is over; start a session when the one `up` waits
 * for stayed silent too long, once.
 *
 * @param context - The seams.
 * @param request - What a new session runs.
 * @param state - Where `up` is.
 * @throws {ForgeError} `supervisor_unresponsive`.
 */
function checkWait(context: CommandContext, request: SessionRequest, state: UpState): void {
	const now = context.seams.clock.now();
	if (now >= state.deadline) {
		throw unresponsive(`The session was not ready within ${UP_TIMEOUT_MS / 1000} s.`);
	}

	if (state.launched !== undefined || now - state.lastAnswer < JOIN_SILENCE_MS) {
		return;
	}

	if (state.relaunched) {
		throw unresponsive("The session that is starting does not answer.");
	}

	state.relaunched = true;
	state.launched = launch(context, forgeFiles(context.cwd), request);
}

/**
 * Wait until the project's session is ready, starting one when none
 * answers for {@link JOIN_SILENCE_MS} (once).
 *
 * @param context - The seams and reporter.
 * @param request - What a new session runs.
 * @param state - Where `up` is.
 * @returns The ready status, and whether this `up` started the session.
 * @rejects As {@link runUpAsync}.
 */
async function waitReadyAsync(
	context: CommandContext,
	request: SessionRequest,
	state: UpState,
): Promise<Ready> {
	for (;;) {
		checkLaunched(context, state);
		const ready = await probeReadyAsync(context, state);
		if (ready !== undefined) {
			return ready;
		}

		checkWait(context, request, state);
		await context.seams.clock.sleep(UP_POLL_MS);
	}
}
