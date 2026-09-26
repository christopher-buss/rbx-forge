import { ForgeError } from "../errors.ts";
import { logFilePath } from "../output/log-file.ts";
import { settlesWithinAsync } from "../seams/clock.ts";
import type { SessionScope } from "./run-session.ts";
import type { SessionSetup } from "./session-body.ts";

/** A promise that never settles: a pause that only time or a signal ends. */
const NEVER = new Promise<void>(() => {
	// Never resolves.
});

/** How often the session checks whether Rojo listens on its port. */
const ROJO_LISTEN_POLL_MS = 100;
/**
 * How long Rojo gets to listen on its port once it runs. Rojo builds the
 * whole project tree before it listens, so a big project takes a while.
 */
export const ROJO_LISTEN_BOUND_MS = 60_000;

/**
 * Wait until Rojo listens on its port, so `ready` means a client can
 * connect, then mark it ready. A session with no Rojo does not wait.
 *
 * @param session - The config, clock, network, and status.
 * @param scope - Its end signal.
 * @returns `true` once Rojo listens, or at once with no Rojo; `false` when
 *   the session ended first.
 * @rejects {ForgeError} `service_failed` when Rojo does not listen within
 *   {@link ROJO_LISTEN_BOUND_MS}.
 */
export async function waitForRojoAsync(
	{ config, context, rojo, status }: Pick<SessionSetup, "config" | "context" | "rojo" | "status">,
	scope: SessionScope,
): Promise<boolean> {
	if (rojo === undefined) {
		return !hasEnded(scope);
	}

	const { clock, network } = context.seams;
	const port = config.rojoPort;
	const deadline = clock.now() + ROJO_LISTEN_BOUND_MS;
	while (!hasEnded(scope)) {
		if (await network.isListeningAsync(port)) {
			// The session may have ended while the check ran.
			if (hasEnded(scope)) {
				return false;
			}

			status.service("rojo", "ready");
			return true;
		}

		if (clock.now() >= deadline) {
			throw new ForgeError(
				"service_failed",
				`rojo did not listen on port ${port} within ${ROJO_LISTEN_BOUND_MS / 1000} s, so the session stopped.`,
				{
					details: { reason: "service_failed:rojo" },
					hint: `Its output is in ${logFilePath(context.cwd, "rojo")}.`,
				},
			);
		}

		// The session's end ends the pause early.
		await settlesWithinAsync(clock, NEVER, ROJO_LISTEN_POLL_MS, scope.signal);
	}

	return false;
}

function hasEnded(scope: SessionScope): boolean {
	return scope.signal.aborted;
}
