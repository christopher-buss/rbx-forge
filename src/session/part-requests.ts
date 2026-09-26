import { type } from "arktype";

import { ForgeError } from "../errors.ts";
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

/**
 * `forge up` on a running session: the control channel asks, the session
 * body adds. The channel opens before the body has started its parts, so a
 * request waits until the body hands its adder over. Requests run one at a
 * time.
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
	/** The body started its parts and can add more now. */
	attach: (add: PartAdder) => void;
	/**
	 * The session is ending: every request from now on, and every waiting one,
	 * fails.
	 */
	close: () => void;
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
 * `forge up`.
 *
 * @returns A link with no adder yet.
 */
export function createPartRequests(): PartRequests {
	const adder = Promise.withResolvers<PartAdder | undefined>();
	let isClosed = false;
	let queue: Promise<unknown> = Promise.resolve();
	return {
		addAsync: async (parts) => {
			const add = await adder.promise;
			if (add === undefined || isClosed) {
				throw stopping();
			}

			const run = queue.then(async () => add(parts));
			queue = run.catch(ignore);
			return run;
		},
		attach: (add) => {
			adder.resolve(add);
		},
		close: () => {
			isClosed = true;
			adder.resolve(undefined);
		},
	};
}

function ignore(): void {
	// The caller of that request gets its failure.
}

function stopping(): ForgeError {
	return new ForgeError("not_running", "The session is stopping; it adds no parts.", {
		hint: 'Start a session with "forge up".',
	});
}
