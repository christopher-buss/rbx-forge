import assert from "node:assert/strict";

import type { CommandContext } from "../commands/context.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { resolveInvocation } from "../process/run-tool.ts";
import type { ReaperEnd } from "../reaper/reaper-client.ts";
import type { RojoPort } from "../rojo/rojo-port.ts";
import { createRojoPort, DEFAULT_ROJO_PORT } from "../rojo/rojo-port.ts";
import { rojoInvocation, rojoServeArgs } from "../rojo/rojo.ts";
import type { Network } from "../seams/network.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { BuildWatch } from "../session/build-watch.ts";
import type { CompilerService } from "../session/compiler-part.ts";
import type { PartRequests } from "../session/part-requests.ts";
import { createPartRequests } from "../session/part-requests.ts";
import type { Pause } from "../session/pause.ts";
import type { SessionPlan } from "../session/plan.ts";
import { compilerWatch, planSession } from "../session/plan.ts";
import type { SessionOutcome } from "../session/run-session.ts";
import { runSessionAsync } from "../session/run-session.ts";
import type { ServiceInvocation } from "../session/service-parts.ts";
import type { SessionSetup } from "../session/session-body.ts";
import { createSessionBody } from "../session/session-body.ts";
import type { SessionSync } from "../session/session-sync.ts";
import { createSessionSync } from "../session/session-sync.ts";
import type { StatusStore } from "../session/status.ts";
import type { StopRequest, StopSource } from "../session/stop-source.ts";
import type { ClearOptions, ForcedCleanup } from "./barrier.ts";
import { clearOldSessionsAsync, finalBarrierAsync, OLD_SESSION_MARGIN_MS } from "./barrier.ts";
import type { SessionRequest } from "./channel.ts";
import { endedResult } from "./end-result.ts";
import { endpointFor } from "./endpoint.ts";
import { acquireSingleton } from "./locks.ts";
import type { ControlSetup } from "./session-control.ts";
import { openSessionAsync } from "./session-control.ts";
import type { ForgeFiles, IdentityRecord, SessionFiles } from "./session-files.ts";
import { forgeFiles, removeSession } from "./session-files.ts";

/** The warning for each escalation of the reaper's end. */
const ESCALATIONS: Readonly<Record<NonNullable<ReaperEnd["escalation"]>, string>> = {
	forced_cleanup:
		"The reaper did not stop, even after its stdin closed; forge cleaned up the session by force.",
	stdin_closed:
		"The reaper did not stop within the grace time; forge closed its stdin, so it forced every tree.",
};

/** What a supervisor runs with besides the command context. */
export interface SupervisorOptions {
	/**
	 * Called once, when the session is first ready: Rojo serves and the
	 * compiler finished its first compile. `forge up` returns then.
	 */
	onReady?: (() => void) | undefined;
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

/** The services of a session, resolved before it starts. */
type SessionServices = Pick<
	SessionSetup,
	"compiler" | "config" | "context" | "plan" | "resolveCompiler" | "resolveRojo"
>;

/** One session's config, files, and resolved services. */
interface OwnSession {
	/** The compiler's builds, for `status --wait`. */
	builds: BuildWatch;
	config: ResolvedConfig;
	files: SessionFiles;
	forge: ForgeFiles;
	/** Links `forge up` on the control channel to the session body. */
	parts: PartRequests;
	/** Rojo's port, chosen once and kept. */
	rojoPort: RojoPort;
	services: SessionServices;
	status: StatusStore;
	/** Links `forge sync` on the control channel to the session body. */
	sync: SessionSync;
}

/**
 * The supervisor of one `forge start` session: the separate
 * process `start` spawns with the owner pipe. It runs the whole session and
 * stops it on the first stop request, which can come at any point of the
 * startup:
 *
 * 1. Load the config and resolve the services it starts with (Rojo, the
 *    compiler).
 * 2. Take the singleton lock (`session_running` when another session holds
 *    it) and keep it until it returns.
 * 3. Barrier: wait until no process of any older session is left (its
 *    lease is free and a scan finds none), and delete those sessions'
 *    directories. With `request.force`, an older session that outlives the
 *    bound is cleaned up by force first.
 * 4. Choose Rojo's port, when the session serves Rojo (`rojo/rojo-port.ts`).
 * 5. Create the session directory: write-once identity record, token,
 *    `current`. Open the control endpoint (`status`, `freshStatus`,
 *    `addParts`, `sync`, `shutdown`), and keep `state.json` up to date.
 * 6. Run the session (`runSessionAsync`): launch the reaper, admit it only
 *    while no stop request came, and run the body.
 * 7. Final barrier: no process of the session is left once the reaper and
 *    every worker are gone. Then delete the session's directory, answer the
 *    requests in progress, and close the endpoint.
 *
 * A stop request before step 5 ends the run with no session; after it, the
 * session's single shutdown path runs.
 *
 * @param context - The project root, environment, seams, and reporter.
 * @param request - What `start` asked for.
 * @param options - Stop requests, pause points, and version.
 * @returns The stop reason and every worker's report, once all are gone.
 * @rejects `session_running`; `previous_generation_alive`;
 *   `cleanup_unverifiable` (only with `force`); `port_in_use`; `rojo_missing`
 *   or `compiler_missing`; a step's failure (such as `compile_failed` or
 *   `hook_failed`);
 *   `cleanup_in_progress` when a worker outlived the wait; a config error;
 *   `endpoint_in_use`; or `reaper_unavailable`.
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
	const plan = planSession(config, request);
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

/**
 * Step 4 of {@link runSupervisorAsync}: the session's Rojo port, chosen now
 * when the session serves Rojo from the start, else at its first attach.
 *
 * @param network - Checks and finds ports.
 * @param services - The plan and the config's port.
 * @returns The port, kept for the session's life.
 * @rejects `port_in_use` when the configured port is busy.
 */
async function sessionPortAsync(
	network: Network,
	{ config, plan }: SessionServices,
): Promise<RojoPort> {
	const port = createRojoPort(network, config.rojoPort);
	if (plan.rojo) {
		await port.chooseAsync();
	}

	return port;
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
	{ builds, config, files, forge, parts, rojoPort, services, status, sync }: OwnSession,
): Promise<SessionOutcome> {
	try {
		return await runSessionAsync(
			{ pause, reaper: seams.reaper },
			{
				graceMs: config.gracefulTimeoutMs,
				hurry: stop.hurry,
				leasePath: files.lease,
				onStop: stop.onStop,
				recordPath: files.record,
				sessionId: files.sessionId,
			},
			createSessionBody({
				...services,
				builds,
				directory: files.directory,
				parts,
				rojoPort,
				status,
				sync,
			}),
		);
	} catch (err) {
		removeSession(seams.fileSystem, forge, files.sessionId);
		throw err;
	}
}

/**
 * Steps 6 and 7 of {@link runSupervisorAsync}, once the session's files and
 * endpoint exist: run it, then the final barrier.
 *
 * @param context - The project root, reporter, and seams.
 * @param options - Stop requests and pause points.
 * @param session - The config, files, services, and status.
 * @param cleanups - What `--force` cleaned up before it.
 * @returns The session's result.
 * @rejects As {@link runSupervisorAsync}.
 */
async function runOpenSessionAsync(
	{ reporter, seams }: CommandContext,
	options: SupervisorOptions,
	session: OwnSession,
	cleanups: Array<ForcedCleanup>,
): Promise<CommandResult> {
	const { files, forge, rojoPort, status } = session;
	const { end, reason } = await runSessionOnceAsync(seams, options, session);
	status.phase("stopping");
	const { escalation } = end;
	if (escalation !== undefined) {
		reporter.emit({ message: ESCALATIONS[escalation], type: "warning" });
	}

	await finalBarrierAsync(seams, forge, files, end.reports);
	status.phase("stopped");
	const port = rojoPort.value();
	return endedResult(reason, {
		...(port === undefined ? {} : { port }),
		reports: end.reports,
		...(cleanups.length > 0 ? { cleanups } : {}),
		...(escalation === undefined ? {} : { escalation }),
	});
}

/**
 * What the control channel knows of the session's services.
 *
 * @param services - The plan and the resolved compiler.
 * @returns What the session runs, and whether it reads builds.
 */
function controlPlan({
	compiler,
	plan,
}: SessionServices): Pick<ControlSetup, "plan" | "readsBuilds"> {
	return {
		plan: { ...plan, compiler: compiler !== undefined },
		readsBuilds: compiler?.parsesDiagnostics === true,
	};
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
	const cleanups = await clearOldAsync(context, config, forge, {
		force,
		signal: options.stop.signal,
	});
	const rojoPort = await sessionPortAsync(context.seams.network, services);
	const late = stopped(options.stop);
	if (late !== undefined) {
		return late;
	}

	const links = { parts: createPartRequests(), sync: createSessionSync() };
	const { builds, files, status, ...control } = await openSessionAsync(context.seams, {
		...controlPlan(services),
		...links,
		forge,
		identity: identityOf(context, config, options.version),
		onReady: options.onReady,
		pause: async () => options.pause("control", options.stop.signal),
		port: rojoPort.value(),
		stop: options.stop,
	});
	try {
		const session = { ...links, builds, config, files, forge, rojoPort, services, status };
		return await runOpenSessionAsync(context, options, session, cleanups);
	} finally {
		// A body that never ran syncback, or never started its parts, leaves
		// no `forge sync` or `forge up` waiting.
		links.parts.close();
		links.sync.close();
		await control.closeAsync();
	}
}

/**
 * Resolve the project's watch-mode compiler.
 *
 * @param context - The project root, environment, and seams.
 * @param config - The resolved config.
 * @returns The compiler service, or `undefined` when the project has none.
 * @throws `compiler_missing`.
 */
function resolveCompiler(
	context: CommandContext,
	config: ResolvedConfig,
): CompilerService | undefined {
	const compiler = compilerWatch(config);
	if (compiler === undefined) {
		return undefined;
	}

	return {
		parsesDiagnostics: compiler.parsesDiagnostics,
		service: {
			...resolveInvocation(context, compiler.call),
			id: "compiler",
			step: `${compiler.call.command} watch`,
		},
	};
}

/**
 * Find Rojo and the compiler the session starts with before anything starts,
 * so a missing tool fails first. Rojo is resolved again on its port once
 * the session chose it.
 *
 * @param context - The project root, environment, and seams.
 * @param config - The resolved config.
 * @param plan - What the session runs.
 * @returns The session, without its directory.
 * @throws `rojo_missing` or `compiler_missing`.
 */
function resolveServices(
	context: CommandContext,
	config: ResolvedConfig,
	plan: SessionPlan,
): SessionServices {
	/**
	 * `rojo serve` on a port.
	 *
	 * @param port - Where Rojo serves.
	 * @returns Its service.
	 * @throws `rojo_missing`.
	 */
	function resolveRojo(port: number): ServiceInvocation {
		const rojo = rojoInvocation(context, config, rojoServeArgs(config.rojoProjectPath, port));
		return { ...rojo, id: "rojo", step: "rojo serve" };
	}

	if (plan.rojo) {
		resolveRojo(config.rojoPort ?? DEFAULT_ROJO_PORT);
	}

	return {
		compiler: plan.compiler === undefined ? undefined : resolveCompiler(context, config),
		config,
		context,
		plan,
		resolveCompiler: () => resolveCompiler(context, config),
		resolveRojo,
	};
}
