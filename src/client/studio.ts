import path from "node:path";

import type { FlagDefinition } from "../cli/flags.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { callSessionAsync } from "../ipc/client.ts";
import type { Environment, Seams } from "../seams/seams.ts";
import { STUDIO_CLOSED_SYNCBACK_MS } from "../session/session-body.ts";
import type { SessionStatus, SessionStudio } from "../session/status.ts";
import { parseStatus } from "../session/status.ts";
import type { RecoveryOptions, StudioTarget } from "../studio/close-studio.ts";
import type { ForgeFiles } from "../supervisor/session-files.ts";
import type { KnownSession } from "./session.ts";

/**
 * How long `stop` and `down` wait for a session's Studio that is still
 * `opening`: launched (or about to be), with the place not open yet. Studio
 * shows a place 5 to 11 s after its start on a desktop; the rest covers a
 * big place, a slow disk, and a compile and build before the launch.
 */
export const STUDIO_OPEN_WAIT_MS = 60_000;

/** How often `stop` and `down` ask the session again. */
const STUDIO_OPEN_POLL_MS = 250;

/**
 * How long `down` lets a session whose own Studio it closed end by itself,
 * before it asks: the session waits for syncback of a last save first.
 */
export const STUDIO_END_WAIT_MS: number = STUDIO_CLOSED_SYNCBACK_MS + 5000;

/** How often `down` looks at a session whose Studio it closed. */
const STUDIO_END_POLL_MS = 100;

/** `--recovery` of `stop` and `down`. */
export const RECOVERY_FLAG: FlagDefinition = {
	name: "recovery",
	config: "studio.autoRecovery",
	kind: "string",
	text: "What to do with the auto-recovery files of a Studio forge ends: move (to .forge/recovery), delete, or keep.",
	value: "<mode>",
};

/**
 * The session's Studio, once it is past `opening`, or when
 * {@link STUDIO_OPEN_WAIT_MS} have passed.
 *
 * @param seams - The clock and transport.
 * @param session - The session's endpoint, token, and id.
 * @returns Its Studio; `undefined` when it did not answer.
 */
export async function waitForSessionStudioAsync(
	seams: Pick<Seams, "clock" | "ipc">,
	session: KnownSession,
): Promise<SessionStudio | undefined> {
	const deadline = seams.clock.now() + STUDIO_OPEN_WAIT_MS;
	for (;;) {
		const studio = await askStudioAsync(seams, session);
		if (studio?.status !== "opening" || seams.clock.now() >= deadline) {
			return studio;
		}

		await seams.clock.sleep(STUDIO_OPEN_POLL_MS);
	}
}

/**
 * The Studio to close for a session's Studio: its place, and the Studio
 * forge started, if it did.
 *
 * @param studio - What the session reports.
 * @returns The target; `undefined` when the session has no Studio open or
 *   opening.
 */
export function sessionStudioTarget({
	pid,
	place,
	startTime,
	status,
}: SessionStudio): StudioTarget | undefined {
	if (place === undefined || (status !== "open" && status !== "opening")) {
		return undefined;
	}

	return {
		place,
		...(pid === undefined || startTime === undefined ? {} : { process: { pid, startTime } }),
	};
}

/**
 * The auto-recovery options of a project.
 *
 * @param environment - Holds the AutoSaves folder locations.
 * @param forge - The project's `.forge` files.
 * @param config - Holds `studio.autoRecovery`, with `--recovery` over it.
 * @returns The mode, the environment, and the recovery folder.
 */
export function recoveryOptions(
	environment: Environment,
	forge: ForgeFiles,
	config: Pick<ResolvedConfig, "studio">,
): RecoveryOptions {
	return {
		env: environment,
		mode: config.studio.autoRecovery,
		recoveryDirectory: path.join(forge.directory, "recovery"),
	};
}

/**
 * Wait for a session whose Studio closed to end by itself, for at most
 * {@link STUDIO_END_WAIT_MS}: a session whose own Studio closed first syncs
 * back a save made just before the close. A session that saw the close and
 * is not stopping goes on without its Studio (`up --studio`): no wait.
 *
 * @param seams - The clock and transport.
 * @param session - Its endpoint, token, and id.
 * @param isGone - Whether its supervisor exited.
 * @returns Whether it exited.
 */
export async function waitForStudioEndAsync(
	seams: Pick<Seams, "clock" | "ipc">,
	session: KnownSession,
	isGone: () => boolean,
): Promise<boolean> {
	const deadline = seams.clock.now() + STUDIO_END_WAIT_MS;
	while (!isGone()) {
		const status = await askStatusAsync(seams, session);
		const didOutliveStudio =
			status?.services.studio.status === "closed" && status.phase !== "stopping";
		if (didOutliveStudio || seams.clock.now() >= deadline) {
			return false;
		}

		await seams.clock.sleep(STUDIO_END_POLL_MS);
	}

	return true;
}

/**
 * Ask a session for its status once.
 *
 * @param seams - The transport.
 * @param session - Its endpoint, token, and id.
 * @returns Its status; `undefined` when it did not answer, or another
 *   session did.
 */
async function askStatusAsync(
	seams: Pick<Seams, "ipc">,
	{ identity, token }: KnownSession,
): Promise<SessionStatus | undefined> {
	let result: Record<string, unknown>;
	try {
		result = await callSessionAsync(
			seams.ipc,
			{ endpoint: identity.endpoint, token },
			"status",
		);
	} catch {
		return undefined;
	}

	const status = parseStatus(result);
	return status?.sessionId === identity.sessionId ? status : undefined;
}

/**
 * Ask a session for its Studio once.
 *
 * @param seams - The transport.
 * @param session - Its endpoint, token, and id.
 * @returns Its Studio; `undefined` when it did not answer, or another
 *   session did.
 */
async function askStudioAsync(
	seams: Pick<Seams, "ipc">,
	session: KnownSession,
): Promise<SessionStudio | undefined> {
	const status = await askStatusAsync(seams, session);
	return status?.services.studio;
}
