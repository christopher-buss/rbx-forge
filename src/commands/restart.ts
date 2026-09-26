import path from "node:path";

import type { FlagDefinition } from "../cli/flags.ts";
import type { KnownSession } from "../client/session.ts";
import { fetchStatusAsync, findSession, restartPartsAsync } from "../client/session.ts";
import { RECOVERY_FLAG } from "../client/studio.ts";
import { loadProjectConfigAsync } from "../config/load.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { PartRestarts, RestartRequest } from "../session/part-restarts.ts";
import { STOP_PARTS_WAIT_MS } from "../session/part-stops.ts";
import type { SessionStatus } from "../session/status.ts";
import { isReady } from "../session/status.ts";
import { STUDIO_PATH_FLAG } from "../studio/discover.ts";
import { failureError } from "../supervisor/channel.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import type { CommandContext, CommandInput } from "./context.ts";
import { listParts } from "./down.ts";
import { describeParts, UP_POLL_MS, UP_TIMEOUT_MS } from "./up.ts";

export const RESTART_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "force",
		kind: "boolean",
		text: "Restart the parts that a forge start terminal owns too.",
	},
	RECOVERY_FLAG,
	STUDIO_PATH_FLAG,
];

/**
 * `forge restart`: restart every part of the project's session that the
 * caller may touch. The session closes its Studio without a save (as
 * `stop` does), stops Rojo and the compiler, and waits until the reaper
 * reports each tree gone; then it starts the compiler again, and, once the
 * compiler's first build is done, builds the place, opens it in a new
 * Studio, and serves Rojo on the same port. A failed compiler starts again
 * too. Parts that a `forge start` terminal owns stay as they are, and are
 * named in `kept`; `--force` restarts them too, and they keep their owner.
 * It returns once no part is starting.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param input - `--force`, `--studio-path`, and the config values flags
 *   set (`--recovery`).
 * @returns The session's status, and the parts it stopped, kept, and
 *   started again.
 * @rejects {ForgeError} `not_running` when no session runs or it stops
 *   meanwhile; `cleanup_in_progress` when an old tree is not proven gone
 *   (nothing started again); Studio's close failure, such as
 *   `identity_mismatch`; the add's failure, such as `compiler_missing` or
 *   `port_in_use`; `supervisor_unresponsive` when it is not ready in time;
 *   config errors from `loadProjectConfigAsync`.
 */
export async function runRestartAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const { cwd, seams } = context;
	const { config } = await loadProjectConfigAsync(cwd, seams.configLoader, input.config);
	const session = findSession(seams.fileSystem, forgeFiles(cwd));
	if (session === undefined) {
		throw new ForgeError("not_running", "No session runs for this project.", {
			hint: 'Start one with "forge up".',
		});
	}

	const restarts = await restartPartsAsync(
		seams.ipc,
		session,
		restartRequest(context, input, config),
		STOP_PARTS_WAIT_MS + config.gracefulTimeoutMs + UP_TIMEOUT_MS,
	);
	const outcome = restarts.studio;
	if (outcome !== undefined && "error" in outcome) {
		throw failureError(outcome.error);
	}

	const status = await waitReadyAsync(context, session);
	const { added, kept, stopped } = restarts;
	return {
		data: { ...status, added, kept, stopped },
		summary: restartSummary(status, restarts),
	};
}

/**
 * What `restart` asks the session for.
 *
 * @param context - The project root.
 * @param input - `--force` and `--studio-path`.
 * @param config - The resolved config: the recovery mode.
 * @returns `force`, the recovery mode, and the absolute Studio path.
 */
function restartRequest(
	{ cwd }: CommandContext,
	{ flags }: CommandInput,
	config: Pick<ResolvedConfig, "studio">,
): RestartRequest {
	const studioPath = flags[STUDIO_PATH_FLAG.name];
	return {
		force: flags["force"] === true,
		recovery: config.studio.autoRecovery,
		...(typeof studioPath === "string" ? { studioPath: path.resolve(cwd, studioPath) } : {}),
	};
}

/**
 * The summary line of a `restart` result.
 *
 * @param status - The session's status once ready.
 * @param restarts - What it stopped, kept, and started.
 * @returns What it restarted, where each part is, and what it kept.
 */
function restartSummary(status: SessionStatus, { added, kept }: PartRestarts): string {
	const restarted = added.length === 0 ? "no part" : listParts(added);
	const pronoun = kept.length === 1 ? "it has" : "they have";
	const names = listParts(kept.map(({ part }) => part));
	const owned =
		kept.length === 0
			? ""
			: ` It left ${names} alone: ${pronoun} an owner, the forge start terminal.`;
	return `Restarted ${restarted} of session ${status.sessionId}: ${describeParts(status)}.${owned}`;
}

/**
 * Wait until no part of the session is starting.
 *
 * @param context - The seams.
 * @param session - Its endpoint and token.
 * @returns Its status once ready.
 * @rejects {ForgeError} As `fetchStatusAsync`; `supervisor_unresponsive`
 *   after {@link UP_TIMEOUT_MS}.
 */
async function waitReadyAsync(
	{ seams }: CommandContext,
	session: KnownSession,
): Promise<SessionStatus> {
	const deadline = seams.clock.now() + UP_TIMEOUT_MS;
	for (;;) {
		const status = await fetchStatusAsync(seams.ipc, session);
		if (isReady(status)) {
			return status;
		}

		if (seams.clock.now() >= deadline) {
			throw new ForgeError(
				"supervisor_unresponsive",
				`The session was not ready within ${UP_TIMEOUT_MS / 1000} s.`,
				{ hint: 'Check "forge status" and "forge logs compiler".' },
			);
		}

		await seams.clock.sleep(UP_POLL_MS);
	}
}
