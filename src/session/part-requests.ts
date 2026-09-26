import { type } from "arktype";

import { ForgeError } from "../errors.ts";
import type { ServiceId } from "./status.ts";

/** A part a client can ask a running session to add. */
export type AddablePart = "compiler";

/** Adds the parts that are missing or failed, and returns those it started. */
export type PartAdder = (parts: ReadonlyArray<AddablePart>) => Promise<Array<ServiceId>>;

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

const addableParts = type("('compiler')[]");

/**
 * Read the parts an `addParts` request asks for.
 *
 * @param value - What the request sent as its `parts`.
 * @returns The parts to add, in the request's order.
 * @throws {ForgeError} `usage` when it is not a list of parts.
 */
export function parseAddableParts(value: unknown): Array<AddablePart> {
	const parsed = addableParts(value);
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
