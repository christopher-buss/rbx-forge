import path from "node:path";

import type { FlagDefinition } from "../cli/flags.ts";
import type { JoinedSession, KnownSession } from "../client/session.ts";
import { JOIN_SILENCE_MS, joinSessionAsync, probeSessionAsync } from "../client/session.ts";
import { ForgeError } from "../errors.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { OwnerJoin, OwnerRelease } from "../session/ownership.ts";
import { releasedResult } from "../session/ownership.ts";
import { listParts } from "../session/part-names.ts";
import type { AddablePart, PartRequest } from "../session/part-requests.ts";
import { STOP_PARTS_WAIT_MS } from "../session/part-stops.ts";
import { STUDIO_PATH_FLAG, withStudioPath } from "../studio/discover.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const START_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "compiler",
		kind: "boolean",
		text: "Compile, build, and run the compiler in watch mode (the default); --no-compiler runs none of them.",
	},
	{
		name: "force",
		kind: "boolean",
		text: "Kill what is left of an earlier session when it outlives the wait, verified as the session's own.",
	},
	{
		name: "open",
		kind: "boolean",
		text: "Open the place in Studio and serve Rojo (the default); --no-open runs neither.",
	},
	STUDIO_PATH_FLAG,
	{
		name: "syncback",
		config: "syncback.runOnStart",
		kind: "boolean",
		text: "Run syncback and its hooks each time Studio saves the place.",
	},
];

/**
 * How long `start` waits for a running session to take it as its owner:
 * the session's own startup, a first build, and Studio opening the place.
 */
const JOIN_TIMEOUT_MS = 300_000;

/** How often `start` looks for the session it joins. */
const JOIN_POLL_MS = 100;

/**
 * `forge start`: run the dev session in this terminal, as its owner:
 * compile and build, open Studio, serve Rojo, run the compiler in watch
 * mode, and, with `--syncback`, sync Studio's saves back.
 *
 * With no session, it runs one in a separate supervisor process
 * (`supervisor/run-supervisor.ts`), bound to this one by the owner pipe.
 * When a session runs (`forge up`), it joins it over the endpoint instead:
 * it takes every running part (with `--no-open`, only the compiler), and
 * starts the missing ones.
 *
 * Either way, its end (Ctrl+C, a closed terminal, its death) stops the parts
 * it started and gives back the parts it took, which run on with no owner;
 * a session with no part left ends. It never closes Studio.
 *
 * @param context - The run: project root, environment, seams, and reporter.
 * @param input - The parsed flags.
 * @returns The stop reason and every worker's report, once all are gone;
 *   or what letting go of the session did.
 * @rejects The session's failure (see `runSupervisorAsync`); a join's
 *   failure, such as `session_running` when another `start` owns the
 *   session.
 */
export async function runStartAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const found = await probeSessionAsync(context.seams, forgeFiles(context.cwd));
	if (found === undefined) {
		try {
			return await superviseAsync(context, input);
		} catch (err) {
			// Another `up` or `start` won the race: join its session.
			if (!(err instanceof ForgeError) || err.code !== "session_running") {
				throw err;
			}
		}
	}

	const session = found?.session ?? (await waitForSessionAsync(context));
	return joinAsync(context, session, wantedParts(context, input.flags));
}

/**
 * Run a new session in a supervisor this process owns.
 *
 * @param context - The run.
 * @param input - The parsed flags.
 * @returns The session's result once it ended, or once it let go of this
 *   `start` and runs on.
 * @rejects As {@link runStartAsync}.
 */
async function superviseAsync(
	{ cwd, env, reporter, seams }: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const run = seams.supervisor({
		cwd,
		env: withStudioPath(env, cwd, seams.host.platform, input.flags),
		onEvent: (event) => {
			reporter.emit(event);
		},
		request: {
			compiler: input.flags["compiler"] !== false,
			config: input.config,
			open: input.flags["open"] !== false,
			...(input.flags["force"] === true ? { force: true } : {}),
		},
	});
	const dispose = seams.signals.onStop(run.stop);
	try {
		return await run.result;
	} finally {
		dispose();
	}
}

/**
 * What a `start` that joins asks the session to start: the compiler unless
 * `--no-compiler`, Studio with its Rojo unless `--no-open`.
 *
 * @param context - The project root, for `--studio-path`.
 * @param flags - The parsed flags.
 * @returns The parts, and the Studio executable to start.
 */
function wantedParts(context: CommandContext, flags: CommandInput["flags"]): PartRequest {
	const parts: Array<AddablePart> = [];
	if (flags["compiler"] !== false) {
		parts.push("compiler");
	}

	if (flags["open"] !== false) {
		parts.push("studio");
	}

	const studioPath = flags[STUDIO_PATH_FLAG.name];
	return {
		parts,
		...(typeof studioPath === "string"
			? { studioPath: path.resolve(context.cwd, studioPath) }
			: {}),
	};
}

/**
 * Wait until the session that holds the project answers.
 *
 * @param context - The seams.
 * @returns Its identity record and token.
 * @rejects {ForgeError} `session_running` when none answers in time.
 */
async function waitForSessionAsync(context: CommandContext): Promise<KnownSession> {
	const { clock } = context.seams;
	const deadline = clock.now() + JOIN_SILENCE_MS;
	for (;;) {
		const found = await probeSessionAsync(context.seams, forgeFiles(context.cwd));
		if (found !== undefined) {
			return found.session;
		}

		if (clock.now() >= deadline) {
			throw new ForgeError(
				"session_running",
				"A session holds this project, but it does not answer.",
				{
					hint: 'Check "forge status", or stop it with "forge down".',
				},
			);
		}

		await clock.sleep(JOIN_POLL_MS);
	}
}

/**
 * Say what a join took and started.
 *
 * @param joined - What it took and started.
 * @returns Such as `took the compiler; started Studio and Rojo`.
 */
function describeJoin({ added, taken }: OwnerJoin): string {
	const done: Array<string> = [];
	if (taken.length > 0) {
		done.push(`took ${listParts(taken)}`);
	}

	if (added.length > 0) {
		done.push(`started ${listParts(added)}`);
	}

	return done.length === 0 ? "it has no part" : done.join("; ");
}

/**
 * Hold a joined session until `release` aborts, then let go.
 *
 * @param joined - The joined session.
 * @param release - Aborts on a stop signal.
 * @returns What letting go did; `undefined` once the session ended, or is
 *   ending.
 * @rejects As `JoinedSession.holdAsync`.
 */
async function holdAsync(
	joined: JoinedSession,
	release: AbortSignal,
): Promise<OwnerRelease | undefined> {
	try {
		return await joined.holdAsync(release, STOP_PARTS_WAIT_MS);
	} catch (err) {
		if (err instanceof ForgeError && err.code === "not_running") {
			return undefined;
		}

		throw err;
	}
}

/**
 * Join a running session as its owner, hold it until a stop signal, then
 * let go.
 *
 * @param context - The seams and reporter.
 * @param session - Its identity record and token.
 * @param request - The parts to start.
 * @returns What letting go did; or that the session ended first.
 * @rejects As {@link runStartAsync}.
 */
async function joinAsync(
	{ reporter, seams }: CommandContext,
	session: KnownSession,
	request: PartRequest,
): Promise<CommandResult> {
	const { sessionId } = session.identity;
	const stop = new AbortController();
	const dispose = seams.signals.onStop(() => {
		stop.abort();
	});
	try {
		const joined = await joinSessionAsync(seams.ipc, session, request, {
			signal: stop.signal,
			waitMs: JOIN_TIMEOUT_MS,
		});
		if (joined === undefined) {
			return {
				data: { sessionId },
				summary: `Stopped before it joined session ${sessionId}; the session let go of what it took.`,
			};
		}

		reporter.emit({
			message: `Joined session ${sessionId}: ${describeJoin(joined.joined)}. Press Ctrl+C to stop.`,
			type: "info",
		});
		const released = await holdAsync(joined, stop.signal);
		return released === undefined
			? { data: { ending: true, sessionId }, summary: `Session ${sessionId} ended.` }
			: releasedResult(released);
	} finally {
		dispose();
	}
}
