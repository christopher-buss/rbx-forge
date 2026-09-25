import path from "node:path";

import type { FlagDefinition } from "../cli/flags.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import { logFilePath } from "../output/log-file.ts";
import { resolveInvocation } from "../process/run-tool.ts";
import type { FinalReport, WorkerReport } from "../reaper/protocol.ts";
import { rojoInvocation, rojoServeArgs } from "../rojo/rojo.ts";
import type { Network } from "../seams/network.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { SessionPlan } from "../session/plan.ts";
import { planSession } from "../session/plan.ts";
import type { SessionEndReason, SessionOutcome } from "../session/run-session.ts";
import { runSessionAsync } from "../session/run-session.ts";
import type { SessionSetup } from "../session/session-body.ts";
import { createSessionBody } from "../session/session-body.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const START_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "compiler",
		kind: "boolean",
		text: "Compile, build, and run the compiler in watch mode (the default); --no-compiler runs none of them.",
	},
	{
		name: "open",
		kind: "boolean",
		text: "Open the place in Studio and stop when Studio closes it (the default); --no-open leaves Studio alone.",
	},
	{
		name: "syncback",
		config: "syncback.runOnStart",
		kind: "boolean",
		text: "Run syncback and its hooks each time Studio saves the place.",
	},
];

/** The files of one session, under `.forge` in the project. */
interface SessionFiles {
	/** `.forge/sessions/<id>`; removed when the session ends. */
	directory: string;
	/** The reaper's lease file. */
	leasePath: string;
	sessionId: string;
}

/**
 * `forge start`: run the dev session in this terminal (spec #28): compile and
 * build, open Studio, serve Rojo, run the compiler in watch mode, and, with
 * `--syncback`, sync Studio's saves back. Every process runs as a worker of
 * the session's reaper, so all of them die with the session: on Ctrl+C, when
 * Studio closes the place, when a service exits, and when this process is
 * killed or its terminal closes.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param input - The parsed flags.
 * @returns The stop reason and every worker's report, once all are gone.
 * @rejects {ForgeError} `port_in_use` when `rojoPort` is busy;
 *   `rojo_missing` or `compiler_missing`; a step's failure (such as
 *   `compile_failed` or `hook_failed`); `service_failed` when a service
 *   exits; `cleanup_in_progress` when a worker outlived the wait; a config
 *   error; or `reaper_unavailable`.
 */
export async function runStartAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const { cwd, seams } = context;
	const { config } = await loadProjectConfigAsync(cwd, seams.configLoader, input.config);
	const plan = planSession(config, {
		compiler: input.flags["compiler"] !== false,
		open: input.flags["open"] !== false,
	});
	await requireFreePortAsync(seams.network, config.rojoPort);
	const session = resolveServices(context, config, plan);
	const files = createSessionFiles(context, seams.randomId());
	try {
		const outcome = await runSessionAsync(
			seams,
			{
				graceMs: config.gracefulTimeoutMs,
				leasePath: files.leasePath,
				onStop: seams.signals.onStop,
				sessionId: files.sessionId,
			},
			createSessionBody({ ...session, directory: files.directory }),
		);
		return startResult(outcome, cwd, config.rojoPort);
	} finally {
		seams.fileSystem.rmSync(files.directory, { recursive: true });
	}
}

async function requireFreePortAsync(network: Network, port: number): Promise<void> {
	if (!(await network.isPortFreeAsync(port))) {
		throw new ForgeError("port_in_use", `Rojo port ${port} is in use.`, {
			hint: "Stop the program that uses it, or set rojoPort to a free port.",
		});
	}
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

function createSessionFiles(
	{ cwd, seams }: Pick<CommandContext, "cwd" | "seams">,
	sessionId: string,
): SessionFiles {
	const directory = path.join(cwd, ".forge", "sessions", sessionId);
	seams.fileSystem.mkdirSync(directory, { recursive: true });
	return { directory, leasePath: path.join(directory, "workers.lock"), sessionId };
}

function survivorsOf(reports: ReadonlyArray<FinalReport>): Array<string> {
	return reports.filter(({ report }) => report.incomplete).map(({ id }) => id);
}

function describeExit({ exitCode, signal }: WorkerReport): string {
	if (exitCode !== null) {
		return `exit code ${exitCode}`;
	}

	return signal === null ? "killed" : `signal ${signal}`;
}

/**
 * The outcome for why the session ended, once every worker is gone.
 *
 * @param reason - Why it ended.
 * @param cwd - The project root, for the log paths.
 * @param data - The port and every worker's report.
 * @returns The result for a stop signal or a closed Studio.
 * @throws The failed step's error, or `service_failed` when a service
 *   exited.
 */
function endedResult(
	reason: SessionEndReason,
	cwd: string,
	data: { port: number; reports: Array<FinalReport> },
): CommandResult {
	switch (reason.type) {
		case "failed": {
			throw reason.error;
		}
		case "service_exited": {
			throw new ForgeError(
				"service_failed",
				`${reason.service} exited (${describeExit(reason.report)}), so the session stopped.`,
				{
					details: { reason: `service_failed:${reason.service}`, reports: data.reports },
					hint: `Its output is in ${logFilePath(cwd, reason.service)}.`,
				},
			);
		}
		case "signal": {
			return {
				data: { ...data, reason: reason.signal },
				summary: `Stopped on ${reason.signal}; every process of the session is gone.`,
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
 * The command's outcome once the session ended.
 *
 * @param outcome - Why it ended (`reason`) and every worker's report (`end`).
 * @param cwd - The project root, for the log paths.
 * @param port - The Rojo port.
 * @returns The result for a stop signal or a closed Studio.
 * @throws {ForgeError} `cleanup_in_progress` when a worker outlived the
 *   wait; else the failed step's error, or `service_failed` when a service
 *   exited.
 */
function startResult({ end, reason }: SessionOutcome, cwd: string, port: number): CommandResult {
	const survivors = survivorsOf(end.reports);
	if (survivors.length > 0) {
		throw new ForgeError(
			"cleanup_in_progress",
			`Processes of ${survivors.join(", ")} were still alive when forge stopped waiting.`,
			{ details: { reports: end.reports }, hint: "Check for them, and stop them by hand." },
		);
	}

	return endedResult(reason, cwd, { port, reports: end.reports });
}
