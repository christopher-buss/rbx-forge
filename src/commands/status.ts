import { fetchStatusAsync, findSession } from "../client/session.ts";
import { ForgeError } from "../errors.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { SessionStatus } from "../session/status.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import type { CommandContext } from "./context.ts";

/**
 * `forge status`: the state of the project's running session: each service's
 * state, the Rojo port, the compiler's last build with its diagnostics, and
 * the last syncback run with its hooks.
 *
 * @param context - The run: project root, seams, and reporter.
 * @returns The session's status as `data`, and one line per service as
 *   `summary`.
 * @rejects {ForgeError} `not_running` when no session runs;
 *   `supervisor_unresponsive` when its supervisor does not answer.
 */
export async function runStatusAsync(context: CommandContext): Promise<CommandResult> {
	const session = findSession(context.seams.fileSystem, forgeFiles(context.cwd));
	if (session === undefined) {
		throw new ForgeError("not_running", "No session runs for this project.", {
			hint: 'Start one with "forge up".',
		});
	}

	const status = await fetchStatusAsync(context.seams.ipc, session);
	return { data: { ...status }, summary: describeStatus(status) };
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The TTY lines of a status: the session, then one line per service.
 *
 * @param status - The session's status.
 * @returns The lines, without a final newline.
 */
function describeStatus({ phase, pid, services, sessionId }: SessionStatus): string {
	const { compiler, rojo, studio, syncback } = services;
	const build = compiler.lastBuild;
	const run = syncback.lastRun;
	const errors = plural(build?.errors ?? 0, "error");
	const built = build === undefined ? "" : `, last build ${errors}`;
	const outcome = run?.ok === true ? "ok" : "failed";
	const synced = run === undefined ? "" : `, last run ${outcome}`;
	const lines = [
		`Session ${sessionId} (pid ${pid}): ${phase}`,
		`  rojo: ${rojo.status} on port ${rojo.port}`,
		`  compiler: ${compiler.status}${built}`,
		`  syncback: ${syncback.status}${synced}`,
		`  studio: ${studio.status}`,
	];
	return lines.join("\n");
}
