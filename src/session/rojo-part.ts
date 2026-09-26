import type { CommandContext } from "../commands/context.ts";
import type { RojoPort } from "../rojo/rojo-port.ts";
import { settlesWithinAsync } from "../seams/clock.ts";
import type { SessionScope } from "./run-session.ts";
import type { RunningPart, ServiceInvocation, ServiceParts } from "./service-parts.ts";
import type { StatusRecorder } from "./status.ts";

/** How often the session checks whether Rojo listens on its port. */
const ROJO_LISTEN_POLL_MS = 100;
/**
 * How long Rojo gets to listen on its port once it runs. Rojo builds the
 * whole project tree before it listens, so a big project takes a while.
 */
export const ROJO_LISTEN_BOUND_MS = 60_000;

/** What Rojo's part runs with. */
export interface RojoSetup {
	context: CommandContext;
	/**
	 * Resolve `rojo serve` on a port.
	 *
	 * @throws `rojo_missing`.
	 */
	resolveRojo: (port: number) => ServiceInvocation;
	/** The session's Rojo port, kept across Rojo's starts. */
	rojoPort: Pick<RojoPort, "chooseAsync">;
	status: Pick<StatusRecorder, "rojoPort" | "service">;
}

/** Rojo resolved on the session's port, not started yet. */
export interface RojoService {
	port: number;
	service: ServiceInvocation;
}

/** Rojo's running part, and its port. */
export interface RunningRojo {
	part: RunningPart;
	port: number;
}

/**
 * Resolve Rojo on the session's port, choosing it the first time.
 *
 * @param setup - The port and the resolution.
 * @returns Rojo, ready to start.
 * @rejects `port_in_use` or `rojo_missing`.
 */
export async function resolveRojoAsync(setup: RojoSetup): Promise<RojoService> {
	const port = await setup.rojoPort.chooseAsync();
	return { port, service: setup.resolveRojo(port) };
}

/**
 * Start Rojo as its part, `starting` until it listens.
 *
 * @param setup - The status.
 * @param parts - Starts the part.
 * @param rojo - Rojo on its port.
 * @returns Its running part, or `undefined` when the session is ending.
 * @rejects As {@link ServiceParts.startAsync}.
 */
export async function startRojoAsync(
	setup: RojoSetup,
	parts: Pick<ServiceParts, "startAsync">,
	{ port, service }: RojoService,
): Promise<RunningRojo | undefined> {
	setup.status.rojoPort(port);
	const part = await parts.startAsync(service, { initial: "starting" });
	return part === undefined ? undefined : { part, port };
}

export function hasEnded(scope: Pick<SessionScope, "signal">): boolean {
	return scope.signal.aborted;
}

/**
 * Wait until Rojo listens on its port, so `ready` means a client can
 * connect, then mark it ready. When it does not listen within
 * {@link ROJO_LISTEN_BOUND_MS}, stop it as `failed`.
 *
 * @param setup - The clock, network, and status.
 * @param scope - Its end signal.
 * @param parts - Stops Rojo when it does not listen.
 * @param rojo - Rojo's part and port.
 * @returns `true` once Rojo listens; `false` when it stopped or the
 *   session ended first.
 */
export async function waitForRojoAsync(
	setup: Pick<RojoSetup, "context" | "status">,
	scope: Pick<SessionScope, "signal" | "track">,
	parts: Pick<ServiceParts, "stop">,
	{ part, port }: RunningRojo,
): Promise<boolean> {
	const { clock, network } = setup.context.seams;
	const deadline = clock.now() + ROJO_LISTEN_BOUND_MS;
	const { stopped } = part;
	const isRunning = watchRunning(scope, stopped);
	while (!hasEnded(scope) && isRunning()) {
		if (await network.isListeningAsync(port)) {
			// The session may have ended, or Rojo stopped, while the check ran.
			if (hasEnded(scope) || !isRunning()) {
				return false;
			}

			setup.status.service("rojo", "ready");
			return true;
		}

		if (clock.now() >= deadline) {
			parts.stop(
				"rojo",
				`rojo did not listen on port ${port} within ${ROJO_LISTEN_BOUND_MS / 1000} s`,
			);
			return false;
		}

		// Rojo's stop or the session's end ends the pause early.
		await settlesWithinAsync(clock, stopped, ROJO_LISTEN_POLL_MS, scope.signal);
	}

	return false;
}

/**
 * Follow whether a part still runs.
 *
 * @param scope - Tracks the watch.
 * @param stopped - Resolves once the part stopped.
 * @returns Whether the part still runs.
 */
function watchRunning(scope: Pick<SessionScope, "track">, stopped: Promise<void>): () => boolean {
	let isRunning = true;
	async function markAsync(): Promise<void> {
		await stopped;
		isRunning = false;
	}

	scope.track(markAsync());
	return () => isRunning;
}
