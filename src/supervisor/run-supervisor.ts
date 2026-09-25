import assert from "node:assert/strict";

import type { CommandContext } from "../commands/context.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import { logFilePath } from "../output/log-file.ts";
import { resolveInvocation } from "../process/run-tool.ts";
import type { FinalReport, WorkerReport } from "../reaper/protocol.ts";
import type { ReaperEnd } from "../reaper/reaper-client.ts";
import { rojoInvocation, rojoServeArgs } from "../rojo/rojo.ts";
import type { Network } from "../seams/network.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { Pause } from "../session/pause.ts";
import type { SessionPlan } from "../session/plan.ts";
import { planSession } from "../session/plan.ts";
import type { SessionEndReason, SessionOutcome } from "../session/run-session.ts";
import { runSessionAsync } from "../session/run-session.ts";
import type { SessionSetup } from "../session/session-body.ts";
import { createSessionBody } from "../session/session-body.ts";
import type { StopRequest, StopSource } from "../session/stop-source.ts";
import type { ClearOptions, ForcedCleanup } from "./barrier.ts";
import { clearOldSessionsAsync, finalBarrierAsync, OLD_SESSION_MARGIN_MS } from "./barrier.ts";
import type { SessionRequest } from "./channel.ts";
import { endpointFor } from "./endpoint.ts";
import { acquireSingleton } from "./locks.ts";
import type { ForgeFiles, IdentityRecord, SessionFiles } from "./session-files.ts";
import { createSession, forgeFiles, removeSession } from "./session-files.ts";

/** The warning for each escalation of the reaper's end. */
const ESCALATIONS: Readonly<Record<NonNullable<ReaperEnd["escalation"]>, string>> = {
	forced_cleanup:
		"The reaper did not stop, even after its stdin closed; forge cleaned up the session by force.",
	stdin_closed:
		"The reaper did not stop within the grace time; forge closed its stdin, so it forced every tree.",
};

/** What a supervisor runs with besides the command context. */
export interface SupervisorOptions {
	/** The test pause points; `neverPauseAsync` in production. */
	pause: Pause;
	/**
	 * Its stop requests: the owner pipe and the stop signals, wired before
	 * this runs.
	 */
	stop: StopSource;
	/** The forge version, for the identity record. */
	version: string;
}

/** One session's config, files, and resolved services. */
interface OwnSession {
	config: ResolvedConfig;
	files: SessionFiles;
	forge: ForgeFiles;
	services: Pick<SessionSetup, "compiler" | "config" | "context" | "plan" | "rojo">;
}

/**
 * The supervisor of one `forge start` session (spec #28): the separate
 * process `start` spawns with the owner pipe. It runs the whole session and
 * stops it on the first stop request, which can come at any point of the
 * startup:
 *
 * 1. Load the config and resolve the services (Rojo, the compiler).
 * 2. Take the singleton lock (`session_running` when another session holds
 *    it) and keep it until it returns.
 * 3. Barrier: wait until no process of any older session is left (its
 *    lease is free and a scan finds none), and delete those sessions'
 *    directories. With `request.force`, an older session that outlives the
 *    bound is cleaned up by force first.
 * 4. Check the fixed Rojo port.
 * 5. Create the session directory: write-once identity record, token,
 *    `current`.
 * 6. Run the session (`runSessionAsync`): launch the reaper, admit it only
 *    while no stop request came, and run the body.
 * 7. Final barrier: no process of the session is left once the reaper and
 *    every worker are gone. Then delete the session's directory.
 *
 * A stop request before step 5 ends the run with no session; after it, the
 * session's single shutdown path runs.
 *
 * @param context - The project root, environment, seams, and reporter.
 * @param request - What `start` asked for.
 * @param options - Stop requests, pause points, and version.
 * @returns The stop reason and every worker's report, once all are gone.
 * @rejects {ForgeError} `session_running`; `previous_generation_alive`;
 *   `cleanup_unverifiable` (only with `force`); `port_in_use`; `rojo_missing`
 *   or `compiler_missing`; a step's failure (such as `compile_failed` or
 *   `hook_failed`); `service_failed` when a service exits;
 *   `cleanup_in_progress` when a worker outlived the wait; a config error; or
 *   `reaper_unavailable`.
 */
export async function runSupervisorAsync(
	context: CommandContext,
	request: SessionRequest,
	options: SupervisorOptions,
): Promise<CommandResult> {
	const { cwd, seams } = context;
	const { pause, stop } = options;
	await pause("created", stop.signal);
	const { config } = await loadProjectConfigAsync(cwd, seams.configLoader, request.config);
	const plan = planSession(config, { compiler: request.compiler, open: request.open });
	const services = resolveServices(context, config, plan);
	await pause("lock", stop.signal);
	const before = stopped(stop);
	if (before !== undefined) {
		return before;
	}

	const forge = forgeFiles(cwd);
	const singleton = acquireSingleton(seams, forge);
	try {
		return await runLockedAsync(context, options, {
			config,
			force: request.force === true,
			forge,
			services,
		});
	} finally {
		singleton.release();
	}
}

function reasonName(request: StopRequest): string {
	return request.type === "signal" ? request.signal : request.type;
}

/**
 * The result of a run that a stop request ended before its session started.
 *
 * @param stop - The stop requests.
 * @returns The result, or `undefined` while no request came.
 */
function stopped(stop: StopSource): CommandResult | undefined {
	const reason = stop.reason();
	if (reason === undefined) {
		return undefined;
	}

	return {
		data: { reason: reasonName(reason), reports: [] },
		summary: `Stopped on ${reasonName(reason)} before the session started; nothing ran.`,
	};
}

function describeExit({ exitCode, signal }: WorkerReport): string {
	if (exitCode !== null) {
		return `exit code ${exitCode}`;
	}

	return signal === null ? "killed" : `signal ${signal}`;
}

/**
 * The error for a service that exited and so ended the session.
 *
 * @param reason - The service and its report.
 * @param cwd - The project root, for the log path.
 * @param reports - Every worker's report.
 * @returns A `service_failed` error.
 */
function serviceFailed(
	{ report, service }: Extract<SessionEndReason, { type: "service_exited" }>,
	cwd: string,
	reports: ReadonlyArray<FinalReport>,
): ForgeError {
	return new ForgeError(
		"service_failed",
		`${service} exited (${describeExit(report)}), so the session stopped.`,
		{
			details: { reason: `service_failed:${service}`, reports },
			hint: `Its output is in ${logFilePath(cwd, service)}.`,
		},
	);
}

/**
 * The outcome for why the session ended, once every worker is gone.
 *
 * @param reason - Why it ended.
 * @param cwd - The project root, for the log paths.
 * @param data - The port and every worker's report.
 * @returns The result for a stop request or a closed Studio.
 * @throws The failed step's error, or `service_failed` when a service
 *   exited.
 */
function endedResult(
	reason: SessionEndReason,
	cwd: string,
	data: {
		cleanups?: Array<ForcedCleanup>;
		escalation?: ReaperEnd["escalation"];
		port: number;
		reports: Array<FinalReport>;
	},
): CommandResult {
	switch (reason.type) {
		case "failed": {
			throw reason.error;
		}
		case "service_exited": {
			throw serviceFailed(reason, cwd, data.reports);
		}
		case "signal": {
			return {
				data: { ...data, reason: reason.signal },
				summary: `Stopped on ${reason.signal}; every process of the session is gone.`,
			};
		}
		case "owner_gone": {
			return {
				data: { ...data, reason: "owner_gone" },
				summary: "forge start is gone; every process of the session is gone.",
			};
		}
		case "studio_closed": {
			return {
				data: { ...data, reason: "studio_closed" },
				summary: "Studio closed the place; every process of the session is gone.",
			};
		}
	}
}

/**
 * Step 6 of {@link runSupervisorAsync}: run the session. When the reaper does
 * not start, nothing of the session ran, so its files go.
 *
 * @param seams - The reaper launcher and file system.
 * @param options - Stop requests and pause points.
 * @param session - The config, files, and services.
 * @returns How the session ended.
 * @rejects `reaper_unavailable`.
 */
async function runSessionOnceAsync(
	seams: CommandContext["seams"],
	{ pause, stop }: SupervisorOptions,
	{ config, files, forge, services }: OwnSession,
): Promise<SessionOutcome> {
	try {
		return await runSessionAsync(
			{ pause, reaper: seams.reaper },
			{
				graceMs: config.gracefulTimeoutMs,
				leasePath: files.lease,
				onStop: stop.onStop,
				recordPath: files.record,
				sessionId: files.sessionId,
			},
			createSessionBody({ ...services, directory: files.directory }),
		);
	} catch (err) {
		removeSession(seams.fileSystem, forge, files.sessionId);
		throw err;
	}
}

/**
 * The identity record of this supervisor.
 *
 * @param context - The project root, environment, and seams.
 * @param config - The resolved config, for the endpoint.
 * @param version - The forge version.
 * @returns The record, with a new session id.
 */
function identityOf(
	{ cwd, env, seams }: CommandContext,
	config: ResolvedConfig,
	version: string,
): IdentityRecord {
	const { clock, host, native } = seams;
	const processStartTime = native().processStartTime(host.pid);
	// This process is alive, so it has a start time.
	assert(processStartTime !== null);
	const startedAt = new Date(clock.now());
	return {
		endpoint: endpointFor({
			buildOutputPath: config.buildOutputPath,
			env,
			platform: host.platform,
			projectRoot: cwd,
			userId: host.userId,
		}),
		pid: host.pid,
		processStartTime,
		sessionId: seams.randomId(),
		startedAt: startedAt.toISOString(),
		version,
	};
}

async function requireFreePortAsync(network: Network, port: number): Promise<void> {
	if (!(await network.isPortFreeAsync(port))) {
		throw new ForgeError("port_in_use", `Rojo port ${port} is in use.`, {
			hint: "Stop the program that uses it, or set rojoPort to a free port.",
		});
	}
}

/**
 * Step 3 of {@link runSupervisorAsync}: the startup barrier, with a warning
 * for each old session `--force` cleaned up.
 *
 * @param context - The seams and reporter.
 * @param config - The resolved config, for the bound.
 * @param forge - The project's `.forge` files.
 * @param options - `--force`, and the stop signal.
 * @returns Every forced cleanup.
 * @rejects As `clearOldSessionsAsync`.
 */
async function clearOldAsync(
	{ reporter, seams }: CommandContext,
	config: ResolvedConfig,
	forge: ForgeFiles,
	options: Pick<ClearOptions, "force" | "signal">,
): Promise<Array<ForcedCleanup>> {
	const cleanups = await clearOldSessionsAsync(seams, forge, {
		...options,
		boundMs: config.gracefulTimeoutMs + OLD_SESSION_MARGIN_MS,
	});
	for (const { killed, sessionId } of cleanups) {
		reporter.emit({
			message: `--force killed ${killed.length} processes of the earlier session ${sessionId}.`,
			type: "warning",
		});
	}

	return cleanups;
}

/**
 * Steps 3 to 7 of {@link runSupervisorAsync}, under the singleton lock.
 *
 * @param context - The project root, environment, and seams.
 * @param options - Stop requests, pause points, and version.
 * @param session - The config, `.forge` files, and services.
 * @returns The session's result.
 * @rejects As {@link runSupervisorAsync}.
 */
async function runLockedAsync(
	context: CommandContext,
	options: SupervisorOptions,
	{
		config,
		force,
		forge,
		services,
	}: Pick<OwnSession, "config" | "forge" | "services"> & { force: boolean },
): Promise<CommandResult> {
	const { cwd, reporter, seams } = context;
	const cleanups = await clearOldAsync(context, config, forge, {
		force,
		signal: options.stop.signal,
	});
	await requireFreePortAsync(seams.network, config.rojoPort);
	const late = stopped(options.stop);
	if (late !== undefined) {
		return late;
	}

	const identity = identityOf(context, config, options.version);
	const files = createSession(seams.fileSystem, forge, identity, seams.randomId());
	const session = { config, files, forge, services };
	const { end, reason } = await runSessionOnceAsync(seams, options, session);
	const { escalation } = end;
	if (escalation !== undefined) {
		reporter.emit({ message: ESCALATIONS[escalation], type: "warning" });
	}

	await finalBarrierAsync(seams, forge, files, end.reports);
	return endedResult(reason, cwd, {
		port: config.rojoPort,
		reports: end.reports,
		...(cleanups.length > 0 ? { cleanups } : {}),
		...(escalation === undefined ? {} : { escalation }),
	});
}

/**
 * Find Rojo and the compiler before anything starts, so a missing tool fails
 * first.
 *
 * @param context - The project root, environment, and seams.
 * @param config - The resolved config.
 * @param plan - What the session runs.
 * @returns The session, without its directory.
 * @throws {ForgeError} `rojo_missing` or `compiler_missing`.
 */
function resolveServices(
	context: CommandContext,
	config: ResolvedConfig,
	plan: SessionPlan,
): Pick<SessionSetup, "compiler" | "config" | "context" | "plan" | "rojo"> {
	const rojo = rojoInvocation(
		context,
		config,
		rojoServeArgs(config.rojoProjectPath, config.rojoPort),
	);
	const { compiler } = plan;
	return {
		compiler:
			compiler === undefined
				? undefined
				: {
						parsesDiagnostics: compiler.parsesDiagnostics,
						service: {
							...resolveInvocation(context, compiler.call),
							id: "compiler",
							step: `${compiler.call.command} watch`,
						},
					},
		config,
		context,
		plan,
		rojo: { ...rojo, id: "rojo", step: "rojo serve" },
	};
}
