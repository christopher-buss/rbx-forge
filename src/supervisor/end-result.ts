import { ForgeError } from "../errors.ts";
import { logFilePath } from "../output/log-file.ts";
import type { FinalReport, WorkerReport } from "../reaper/protocol.ts";
import type { ReaperEnd } from "../reaper/reaper-client.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { SessionEndReason } from "../session/run-session.ts";
import type { ForcedCleanup } from "./barrier.ts";

/** An end that needs no detail beyond its name. */
type QuietEnd = Exclude<SessionEndReason["type"], "failed" | "service_exited" | "signal">;

/** The summary of each end that needs no detail. */
const STOP_SUMMARIES = {
	owner_gone: "forge start is gone; every process of the session is gone.",
	shutdown: "Stopped on request; every process of the session is gone.",
	studio_closed: "Studio closed the place; every process of the session is gone.",
} satisfies Record<QuietEnd, string>;

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
export function endedResult(
	reason: SessionEndReason,
	cwd: string,
	data: {
		cleanups?: Array<ForcedCleanup>;
		escalation?: ReaperEnd["escalation"];
		port: null | number;
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
		case "owner_gone":
		case "shutdown":
		case "studio_closed": {
			return {
				data: { ...data, reason: reason.type },
				summary: STOP_SUMMARIES[reason.type],
			};
		}
	}
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
