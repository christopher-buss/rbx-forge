import { type } from "arktype";

import { findSession } from "../client/session.ts";
import { ForgeError } from "../errors.ts";
import { callSessionAsync } from "../ipc/client.ts";
import type { CommandResult } from "../seams/reporter.ts";
import { parseHookResults } from "../session/status.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import type { CommandContext } from "./context.ts";

/**
 * How long `forge sync` waits for the session's answer: the run waits for
 * the one going (a save's), then runs Rojo and every hook, each hook up to
 * its own timeout. A session that dies meanwhile closes the connection, so
 * the wait ends at once.
 */
export const SYNC_WAIT_MS: number = 30 * 60_000;

const syncResult = type({
	durationMs: "number",
	hooks: "unknown",
	input: "string",
	project: "string",
});

/**
 * `forge sync`: run syncback with its hooks through the project's running
 * session. The session runs it one at a time with its
 * save watch: a sync asked during a run waits for it, then runs once more.
 *
 * @param context - The run: project root, seams, and reporter.
 * @returns What was synced and every hook result.
 * @rejects {ForgeError} `not_running` when no session runs or it is
 *   stopping; `supervisor_unresponsive` when it does not answer; the run's
 *   own failure, such as `syncback_unsupported`, `process_failed`, or
 *   `hook_failed` with the hook results in `details.hooks`.
 */
export async function runSyncAsync(context: CommandContext): Promise<CommandResult> {
	const session = findSession(context.seams.fileSystem, forgeFiles(context.cwd));
	if (session === undefined) {
		throw new ForgeError("not_running", "No session runs for this project.", {
			hint: 'Start one with "forge up", or run "forge syncback" without a session.',
		});
	}

	const answer = await callSessionAsync(
		context.seams.ipc,
		{ endpoint: session.identity.endpoint, token: session.token },
		"sync",
		{ responseTimeoutMs: SYNC_WAIT_MS },
	);
	const parsed = syncResult(answer);
	if (parsed instanceof type.errors) {
		throw new ForgeError("internal_error", "The session answered sync with something else.", {
			hint: "The session may run another forge version. Stop it, then start it again.",
		});
	}

	const { durationMs, input, project } = parsed;
	return {
		data: { durationMs, hooks: parseHookResults(parsed.hooks), input, project },
		summary: `Synced ${input} into ${project} through session ${session.identity.sessionId}.`,
	};
}
