import path from "node:path";

import type { FlagDefinition, FlagValues } from "../cli/flags.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import { ForgeError } from "../errors.ts";
import type { FinalReport, WorkerReport } from "../reaper/protocol.ts";
import { rojoInvocation, rojoServeArgs } from "../rojo/rojo.ts";
import type { Network } from "../seams/network.ts";
import type { CommandResult, Reporter } from "../seams/reporter.ts";
import type { SessionOutcome } from "../session/run-session.ts";
import { runSessionAsync } from "../session/run-session.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const START_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "compiler",
		kind: "boolean",
		text: "Run the compiler in watch mode. For now, pass --no-compiler.",
	},
	{
		name: "open",
		kind: "boolean",
		text: "Open the place in Studio. For now, pass --no-open.",
	},
];

/** The files of one session, under `.forge` in the project. */
interface SessionFiles {
	/** `.forge/sessions/<id>`; removed when the session ends. */
	directory: string;
	/** The reaper's lease file. */
	leasePath: string;
	/** Rojo's stdout and stderr, appended across sessions. */
	rojoLog: string;
	sessionId: string;
}

const ROJO = "rojo";
const STEP = "rojo serve";

/**
 * `forge start --no-open --no-compiler`: serve the Rojo project in this
 * terminal. Rojo runs as a worker of the session's reaper, so every Rojo
 * process dies with the session: on Ctrl+C, when Rojo exits, and when this
 * process is killed or its terminal closes.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param input - The parsed flags.
 * @returns The stop reason and every worker's report, once all are gone.
 * @rejects {ForgeError} `usage` without `--no-open --no-compiler`;
 *   `port_in_use` when `rojoPort` is busy; `rojo_missing`;
 *   `service_failed` when Rojo exits; `cleanup_in_progress` when a worker
 *   outlived the wait; a config error; or `reaper_unavailable`.
 */
export async function runStartAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	requireRojoOnly(input.flags);
	const { cwd, env, reporter, seams } = context;
	const { config } = await loadProjectConfigAsync(cwd, seams.configLoader, input.config);
	const { rojoPort: port, rojoProjectPath: project } = config;
	await requireFreePortAsync(seams.network, port);
	const invocation = rojoInvocation(context, config, rojoServeArgs(project, port));
	const files = createSessionFiles(context, seams.randomId());
	reporter.emit({ name: STEP, status: "started", type: "step" });
	try {
		const outcome = await runSessionAsync(seams, {
			graceMs: config.gracefulTimeoutMs,
			leasePath: files.leasePath,
			onReady: () => {
				announceReady(reporter, project, port);
			},
			services: [{ id: ROJO, ...invocation, cwd, env, log: files.rojoLog }],
			sessionId: files.sessionId,
		});
		return startResult(outcome, files, port);
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

function announceReady(reporter: Reporter, project: string, port: number): void {
	reporter.emit({ name: STEP, status: "succeeded", type: "step" });
	reporter.emit({
		message: `Rojo serves ${project} on port ${port}. Press Ctrl+C to stop.`,
		type: "info",
	});
}

function requireRojoOnly(flags: FlagValues): void {
	if (flags["open"] !== false || flags["compiler"] !== false) {
		throw new ForgeError(
			"usage",
			"forge start runs only Rojo for now: pass --no-open --no-compiler.",
			{ hint: 'Run "forge start --help" for usage.' },
		);
	}
}

function createSessionFiles(
	{ cwd, seams }: Pick<CommandContext, "cwd" | "seams">,
	sessionId: string,
): SessionFiles {
	const directory = path.join(cwd, ".forge", "sessions", sessionId);
	const logs = path.join(cwd, ".forge", "logs");
	seams.fileSystem.mkdirSync(directory, { recursive: true });
	seams.fileSystem.mkdirSync(logs, { recursive: true });
	return {
		directory,
		leasePath: path.join(directory, "workers.lock"),
		rojoLog: path.join(logs, "rojo.log"),
		sessionId,
	};
}

function describeExit({ exitCode, signal }: WorkerReport): string {
	if (exitCode !== null) {
		return `exit code ${exitCode}`;
	}

	return signal === null ? "killed" : `signal ${signal}`;
}

function survivorsOf(reports: ReadonlyArray<FinalReport>): Array<string> {
	return reports.filter(({ report }) => report.incomplete).map(({ id }) => id);
}

/**
 * The command's outcome once the session ended.
 *
 * @param outcome - Why it ended (`reason`) and every worker's report (`end`).
 * @param files - The session's files, for the log path.
 * @param port - The Rojo port.
 * @returns The result for a stop signal.
 * @throws {ForgeError} `cleanup_in_progress` when a worker outlived the
 *   wait, else `service_failed` when a service exited.
 */
function startResult(
	{ end, reason }: SessionOutcome,
	files: SessionFiles,
	port: number,
): CommandResult {
	const survivors = survivorsOf(end.reports);
	if (survivors.length > 0) {
		throw new ForgeError(
			"cleanup_in_progress",
			`Processes of ${survivors.join(", ")} were still alive when forge stopped waiting.`,
			{ details: { reports: end.reports }, hint: "Check for them, and stop them by hand." },
		);
	}

	if (reason.type === "service_exited") {
		throw new ForgeError(
			"service_failed",
			`${reason.service} exited (${describeExit(reason.report)}), so the session stopped.`,
			{
				details: { reason: `service_failed:${reason.service}`, reports: end.reports },
				hint: `Its output is in ${files.rojoLog}.`,
			},
		);
	}

	return {
		data: { port, reason: reason.signal, reports: end.reports },
		summary: `Stopped on ${reason.signal}; every process of the session is gone.`,
	};
}
