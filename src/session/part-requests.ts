import { type } from "arktype";

import { ForgeError } from "../errors.ts";
import type { PartStopper } from "./part-stops.ts";
import type { PartId } from "./status.ts";

/**
 * A part a client can ask a running session to add: `studio` attaches
 * Studio with its Rojo.
 */
export type AddablePart = "compiler" | "studio";

/** What one `addParts` request asks for. */
export interface PartRequest {
	readonly parts: ReadonlyArray<AddablePart>;
	/** The Studio executable to start (`up --studio-path`), absolute. */
	readonly studioPath?: string | undefined;
}

/** Adds the parts that are missing or failed, and returns those it started. */
export type PartAdder = (request: PartRequest) => Promise<Array<PartId>>;

/** What the session body adds and stops parts with. */
export interface PartHandlers {
	add: PartAdder;
	stop: PartStopper;
}

/**
 * `forge up`, `down`, and `stop` on a running session: the control channel
 * asks, the session body adds or stops. The channel opens before the body
 * has started its parts, so an add waits until the body hands its handlers
 * over; a stop before that fails at once, and the client stops the whole
 * session. Requests run one at a time.
 */
export interface PartRequests {
	/**
	 * Add the parts that are missing or failed.
	 *
	 * @returns The parts it started, in order.
	 * @rejects {ForgeError} `not_running` once the session is stopping; the
	 *   adder's failure, such as `compiler_missing`.
	 */
	addAsync: PartAdder;
	/** The body started its parts and can add and stop them now. */
	attach: (handlers: PartHandlers) => void;
	/**
	 * The session is ending: every request from now on, and every waiting one,
	 * fails.
	 */
	close: () => void;
	/**
	 * Stop the parts a request may stop.
	 *
	 * @returns What it stopped and kept.
	 * @rejects {ForgeError} `not_running` while the session starts, or once it
	 *   is stopping.
	 */
	stopAsync: PartStopper;
}

const partRequest = type({
	"parts": "('compiler' | 'studio')[]",
	"studioPath?": "string",
});

/**
 * Read what an `addParts` request asks for.
 *
 * @param parameters - What the request sent.
 * @returns The parts to add, in the request's order, and the Studio path.
 * @throws {ForgeError} `usage` when `parts` is not a list of parts.
 */
export function parsePartRequest(parameters: Record<string, unknown>): PartRequest {
	const parsed = partRequest(parameters);
	if (parsed instanceof type.errors) {
		throw new ForgeError("usage", `addParts takes a list of parts: ${parsed.summary}`);
	}

	return parsed;
}

/**
 * Make the link between a session's control channel and its body for
 * `forge up`, `down`, and `stop`.
 *
 * @returns A link with no handlers yet.
 */
export function createPartRequests(): PartRequests {
	const attached = Promise.withResolvers<PartHandlers | undefined>();
	const link: { handlers?: PartHandlers; isClosed: boolean } = { isClosed: false };
	const enqueueAsync = createQueue();
	return {
		addAsync: async (parts) => {
			// Once attached, requests queue in the order they came.
			const handlers =
				link.handlers === undefined || link.isClosed
					? await waitForHandlersAsync(attached.promise, link)
					: link.handlers;
			return enqueueAsync(async () => handlers.add(parts));
		},
		attach: (handlers) => {
			link.handlers = handlers;
			attached.resolve(handlers);
		},
		close: () => {
			link.isClosed = true;
			attached.resolve(undefined);
		},
		stopAsync: async (request) => {
			const { handlers, isClosed } = link;
			if (handlers === undefined || isClosed) {
				throw isClosed ? stopping() : starting();
			}

			return enqueueAsync(async () => handlers.stop(request));
		},
	};
}

function ignore(): void {
	// The caller of that request gets its failure.
}

/**
 * A queue that runs one request at a time, in order; a failed one does not
 * hold up the next.
 *
 * @returns What queues a request, and resolves as it does.
 */
function createQueue(): <T>(run: () => Promise<T>) => Promise<T> {
	let queue: Promise<unknown> = Promise.resolve();
	return async (run) => {
		const next = queue.then(run);
		queue = next.catch(ignore);
		return next;
	};
}

function stopping(): ForgeError {
	return new ForgeError("not_running", "The session is stopping; it adds and stops no parts.", {
		hint: 'Start a session with "forge up".',
	});
}

/**
 * Wait until the body hands its handlers over.
 *
 * @param attached - Resolves with them, or with none once closed.
 * @param link - Whether the link closed.
 * @param link.isClosed - Set once the session is stopping.
 * @returns What adds and stops parts.
 * @rejects {ForgeError} `not_running` once the session is stopping.
 */
async function waitForHandlersAsync(
	attached: Promise<PartHandlers | undefined>,
	link: { isClosed: boolean },
): Promise<PartHandlers> {
	const handlers = await attached;
	if (handlers === undefined || link.isClosed) {
		throw stopping();
	}

	return handlers;
}

function starting(): ForgeError {
	return new ForgeError("not_running", "The session is starting; it stops no part yet.", {
		hint: "Stop the whole session.",
	});
}
